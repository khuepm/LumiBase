"use client";

import { useEffect, useRef } from "react";
import { Camera, Geometry, Mesh, Plane, Program, Renderer, RenderTarget } from "ogl";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * GlassGem — a rough-cut crystal that bends the sky behind it, surrounded by a
 * drift of smaller shards that are lit only by the crystal at the centre.
 *
 * Why it is built this way: WebGL cannot read DOM pixels, and pushing a
 * displacement map through an SVG filter every frame is not viable (Safari
 * aside, there is no fast path to hand a live canvas to feImage). So the
 * backdrop is *drawn* in pass one — the same near-black nebula and starfield the
 * page uses — and the crystal refracts that texture in screen space. The page
 * background is procedural, so the seam does not read.
 *
 * The look comes from four things layered on a faceted hull:
 *   · screen-space refraction — UVs offset along the refracted view vector, so
 *     whatever sits behind the gem visibly bends as it turns
 *   · dispersion — R/G/B sampled at three slightly different IORs, which is what
 *     produces the rainbow fringes along the edges
 *   · Fresnel — grazing facets go bright, facets facing you stay clear
 *   · a fixed directional light, so rotation sweeps specular across the facets
 *
 * The hull is opaque (it samples the backdrop rather than alpha-blending), which
 * sidesteps transparency sorting entirely. The shards are the opposite: they are
 * additively blended and carry no body of their own, so they only exist where
 * light is passing through them.
 */

type V3 = [number, number, number];

interface Facet {
  /** Outward plane normal — kept so triangle winding can be corrected. */
  n: V3;
  verts: V3[];
}

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Deterministic RNG: the cut must be identical on every load and every device. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function startingBox(h: number): Facet[] {
  const axes: V3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  return axes.map((n) => {
    // Two in-plane axes, so the face can be written as a quad.
    const up: V3 = Math.abs(n[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const e1: V3 = [
      up[1] * n[2] - up[2] * n[1],
      up[2] * n[0] - up[0] * n[2],
      up[0] * n[1] - up[1] * n[0],
    ];
    const e2: V3 = [
      n[1] * e1[2] - n[2] * e1[1],
      n[2] * e1[0] - n[0] * e1[2],
      n[0] * e1[1] - n[1] * e1[0],
    ];
    const c: V3 = [n[0] * h, n[1] * h, n[2] * h];
    const corner = (s1: number, s2: number): V3 => [
      c[0] + e1[0] * s1 * h + e2[0] * s2 * h,
      c[1] + e1[1] * s1 * h + e2[1] * s2 * h,
      c[2] + e1[2] * s1 * h + e2[2] * s2 * h,
    ];
    return { n, verts: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] };
  });
}

/**
 * Intersect a convex solid with the half-space `dot(p, n) <= d`.
 *
 * Every existing face is clipped in place (Sutherland–Hodgman — valid here
 * because each face is planar and convex, so the cut is a single segment), the
 * segment endpoints are collected, and they close into one new cap facet. Doing
 * the cut this way is what produces *irregular* facets: the plane angles and
 * offsets are random, so no two faces come out the same size, which is exactly
 * what a symmetric table cut cannot give you.
 */
function clipHalfSpace(faces: Facet[], n: V3, d: number): Facet[] {
  const EPS = 1e-6;
  const out: Facet[] = [];
  const cap: V3[] = [];

  for (const f of faces) {
    const poly = f.verts;
    const kept: V3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const da = dot3(a, n) - d;
      const db = dot3(b, n) - d;
      if (da <= EPS) kept.push(a);
      if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
        const t = da / (da - db);
        const p: V3 = [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];
        kept.push(p);
        cap.push(p);
      }
    }
    if (kept.length >= 3) out.push({ n: f.n, verts: kept });
  }

  // Close the opening the cut just made.
  const uniq: V3[] = [];
  for (const p of cap) {
    if (!uniq.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-5)) {
      uniq.push(p);
    }
  }
  if (uniq.length >= 3) {
    const c: V3 = [0, 0, 0];
    for (const p of uniq) {
      c[0] += p[0] / uniq.length;
      c[1] += p[1] / uniq.length;
      c[2] += p[2] / uniq.length;
    }
    const ref: V3 = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1: V3 = [
      ref[1] * n[2] - ref[2] * n[1],
      ref[2] * n[0] - ref[0] * n[2],
      ref[0] * n[1] - ref[1] * n[0],
    ];
    const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
    e1[0] /= l1;
    e1[1] /= l1;
    e1[2] /= l1;
    const e2: V3 = [
      n[1] * e1[2] - n[2] * e1[1],
      n[2] * e1[0] - n[0] * e1[2],
      n[0] * e1[1] - n[1] * e1[0],
    ];
    uniq.sort((p, q) => {
      const pa = Math.atan2(
        (p[0] - c[0]) * e2[0] + (p[1] - c[1]) * e2[1] + (p[2] - c[2]) * e2[2],
        (p[0] - c[0]) * e1[0] + (p[1] - c[1]) * e1[1] + (p[2] - c[2]) * e1[2]
      );
      const qa = Math.atan2(
        (q[0] - c[0]) * e2[0] + (q[1] - c[1]) * e2[1] + (q[2] - c[2]) * e2[2],
        (q[0] - c[0]) * e1[0] + (q[1] - c[1]) * e1[1] + (q[2] - c[2]) * e1[2]
      );
      return pa - qa;
    });
    out.push({ n, verts: uniq });
  }

  return out;
}

/**
 * A rough-cut crystal: a box hacked down by `cuts` random planes, then squashed
 * anisotropically so it reads as a mineral shard rather than a jewel. Non-indexed
 * with per-triangle normals — flat shading is what makes facets read as facets.
 */
function buildCrystal({
  seed,
  cuts = 22,
  // A wide offset range is what varies facet *size*: a plane near the low end
  // takes a deep bite, one near the high end only shaves a corner.
  minOffset = 0.46,
  maxOffset = 1.0,
  stretch = [0.94, 1.2, 0.88] as V3,
}: {
  seed: number;
  cuts?: number;
  minOffset?: number;
  maxOffset?: number;
  stretch?: V3;
}) {
  const rnd = mulberry32(seed);
  // Start close to the cut radius: a roomy box leaves cuts that miss, and the
  // hull comes out with six big faces instead of a scatter of small ones.
  let faces = startingBox(1.02);

  for (let i = 0; i < cuts; i++) {
    // Uniform on the sphere, so the facet directions have no residual axis bias.
    const z = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const n: V3 = [r * Math.cos(th), z, r * Math.sin(th)];
    faces = clipHalfSpace(faces, n, minOffset + rnd() * (maxOffset - minOffset));
  }

  const pos: number[] = [];
  const nrm: number[] = [];
  let maxR = 0;

  for (const f of faces) {
    const v = f.verts.map(
      (p): V3 => [p[0] * stretch[0], p[1] * stretch[1], p[2] * stretch[2]]
    );
    for (const p of v) maxR = Math.max(maxR, Math.hypot(p[0], p[1], p[2]));
    for (let i = 1; i < v.length - 1; i++) {
      const a = v[0]!;
      const b = v[i]!;
      const c = v[i + 1]!;
      const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = u[1] * w[2] - u[2] * w[1];
      const ny = u[2] * w[0] - u[0] * w[2];
      const nz = u[0] * w[1] - u[1] * w[0];
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) continue; // sliver from a near-tangent cut
      // The stretch can flip winding, so orient against the stored plane normal.
      const s = dot3([nx / len, ny / len, nz / len], f.n) < 0 ? -1 : 1;
      for (const p of [a, b, c]) {
        pos.push(p[0], p[1], p[2]);
        nrm.push((s * nx) / len, (s * ny) / len, (s * nz) / len);
      }
    }
  }

  // Normalise so every seed yields the same on-screen size.
  const k = maxR > 0 ? 1 / maxR : 1;
  for (let i = 0; i < pos.length; i++) pos[i]! *= k;

  return { position: new Float32Array(pos), normal: new Float32Array(nrm) };
}

/** The site hue ramp — shards pick from it so the field reads as brand, not confetti. */
const SHARD_TINTS: V3[] = [
  [1.0, 0.69, 0.13], // gold
  [1.0, 0.3, 0.55], // rose
  [0.84, 0.12, 0.62], // magenta
  [0.61, 0.36, 1.0], // violet
  [0.16, 0.85, 0.9], // cyan
  [0.2, 0.88, 0.71], // teal
];

const SHARD_COUNT = 68;
const SHARD_SEEDS = [9127, 4413, 20261];

/** Instance attributes for one shard group, laid out for `instanced: 1`. */
function buildShardField(groups: number) {
  const rnd = mulberry32(77345);
  const per = Array.from({ length: groups }, () => ({
    offset: [] as number[],
    axis: [] as number[],
    scaleSpin: [] as number[],
    phase: [] as number[],
    tint: [] as number[],
  }));

  for (let i = 0; i < SHARD_COUNT; i++) {
    // Reject anything that would sit on top of the crystal — the field should
    // frame it, not crowd it.
    let x = 0;
    let y = 0;
    let z = 0;
    for (let guard = 0; guard < 40; guard++) {
      x = rnd() * 2 - 1;
      y = (rnd() * 2 - 1) * 1.28;
      z = rnd() * 3.2 - 2.1;
      if (Math.hypot(x * 2.4, y) > 1.75 || z < -0.8) break;
    }

    const az = rnd() * 2 - 1;
    const ath = rnd() * Math.PI * 2;
    const ar = Math.sqrt(Math.max(0, 1 - az * az));
    // Shards nearer the camera are drawn a touch larger, so the field has depth.
    const scale = (0.04 + rnd() * 0.068) * (1 + z * 0.12);
    const tint = SHARD_TINTS[Math.floor(rnd() * SHARD_TINTS.length)] ?? SHARD_TINTS[0]!;

    const g = per[i % groups]!;
    g.offset.push(x, y, z);
    g.axis.push(ar * Math.cos(ath), az, ar * Math.sin(ath));
    g.scaleSpin.push(scale, (rnd() * 0.5 + 0.18) * (rnd() > 0.5 ? 1 : -1));
    g.phase.push(rnd() * Math.PI * 2);
    g.tint.push(tint[0], tint[1], tint[2]);
  }

  return per.map((g) => ({
    iOffset: new Float32Array(g.offset),
    iAxis: new Float32Array(g.axis),
    iScaleSpin: new Float32Array(g.scaleSpin),
    iPhase: new Float32Array(g.phase),
    iTint: new Float32Array(g.tint),
  }));
}

const BACKDROP_VERT = `#version 300 es
in vec2 uv;
in vec2 position;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }`;

/** The page's own sky, redrawn so the crystal has something real to bend. */
const BACKDROP_FRAG = `#version 300 es
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect + 0.5, uv.y);

  vec3 col = vec3(0.027, 0.024, 0.047);
  float t = uTime * 0.06;
  // Kept faint on purpose: a strong colour wash behind the crystal turns it into
  // a solid amethyst. The colour should come from dispersion, not from the sky.
  col += vec3(0.38, 0.20, 0.85) * 0.13 * smoothstep(0.85, 0.0, length(p - vec2(0.72 + sin(t) * 0.06, 0.28)));
  col += vec3(0.84, 0.12, 0.62) * 0.10 * smoothstep(0.85, 0.0, length(p - vec2(0.22, 0.74 + cos(t * 0.9) * 0.05)));
  col += vec3(0.16, 0.85, 0.90) * 0.09 * smoothstep(0.75, 0.0, length(p - vec2(0.52, 0.9)));
  col += vec3(1.00, 0.69, 0.13) * 0.05 * smoothstep(0.55, 0.0, length(p - vec2(0.9, 0.85)));
  // A faint core glow, so the story the shards tell — lit from the centre — has
  // a visible source. Kept tight and dim: the crystal sits directly on top of
  // it, and anything stronger is refracted straight through its body as a
  // colour cast, which is what made it read as amethyst.
  col += vec3(0.66, 0.60, 1.00) * 0.03 * smoothstep(0.30, 0.0, length(p - vec2(0.5, 0.5)));

  // Stars carry the whole trick: a bent gradient looks like nothing, while bent
  // points of light read instantly as glass. Two densities, so the smear has
  // both fine grain and a few bright anchors.
  for (int k = 0; k < 2; k++) {
    float scale = k == 0 ? 72.0 : 30.0;
    float cut = k == 0 ? 0.93 : 0.975;
    float gain = k == 0 ? 0.7 : 1.6;
    vec2 g = floor(p * scale);
    float s = hash(g + float(k) * 17.0);
    if (s > cut) {
      vec2 f = fract(p * scale) - 0.5;
      float d = 1.0 - smoothstep(0.0, 0.3, length(f));
      col += vec3(0.86, 0.84, 1.0) * d * gain * (0.65 + 0.35 * sin(uTime * 1.8 + s * 40.0));
    }
  }
  fragColor = vec4(col, 1.0);
}`;

const BLIT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = texture(uTexture, vUv); }`;

const GEM_VERT = `#version 300 es
in vec3 position;
in vec3 normal;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
out vec3 vNormal;
out vec3 vViewPos;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const GEM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBackdrop;
uniform vec2 uResolution;
uniform float uIOR;
uniform float uDispersion;
uniform float uStrength;
uniform vec3 uLightDir;
uniform vec3 uEdge;
in vec3 vNormal;
in vec3 vViewPos;
out vec4 fragColor;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);          // surface → eye
  vec2 screen = gl_FragCoord.xy / uResolution;

  // Screen-space refraction, sampled three times at slightly different indices:
  // the channel split is the dispersion, and it is what puts colour on the edges.
  vec3 rR = refract(-V, N, 1.0 / (uIOR - uDispersion));
  vec3 rG = refract(-V, N, 1.0 / uIOR);
  vec3 rB = refract(-V, N, 1.0 / (uIOR + uDispersion));

  // Thicker where you look through it edge-on, so the smear grows toward the rim.
  float thick = mix(0.55, 1.6, 1.0 - abs(dot(N, V)));
  vec3 refracted = vec3(
    texture(uBackdrop, screen + rR.xy * uStrength * thick).r,
    texture(uBackdrop, screen + rG.xy * uStrength * thick).g,
    texture(uBackdrop, screen + rB.xy * uStrength * thick).b
  );

  // A second sample off the flipped normal stands in for the far surface, so the
  // body carries internal structure instead of one flat wash.
  // Kept light: the more of this second, heavily-offset sample is mixed in, the
  // more the body averages into a milky wash instead of showing crisp bent
  // stars — and crisp bent stars are the whole reason the glass reads as clear.
  vec3 back = texture(uBackdrop, screen + refract(-V, -N, uIOR).xy * uStrength * 0.6).rgb;
  refracted = mix(refracted, back, 0.18);

  // Neutral on purpose. Any hue applied to the body reads as *coloured glass*
  // — the body should be the backdrop and nothing else, with all the colour
  // coming from dispersion at the edges.
  refracted *= mix(vec3(1.14), vec3(0.97, 0.98, 1.03), 1.0 - abs(dot(N, V)));

  // Grazing facets brighten; facets pointed at you stay clear.
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);

  // Fixed light, rotating gem → specular sweeps facet to facet as it turns.
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 140.0);

  vec3 col = refracted * 1.22;
  col += uEdge * fres * 0.40;                  // rim, kept off the broad facets
  col += vec3(1.0, 0.99, 0.97) * spec * 1.3;   // highlight
  // Facets still have to separate from one another, but the term doing it is
  // near-white now: separating them by *luminance* keeps the glass colourless,
  // where separating them by hue is what made the whole body read as amethyst.
  col += vec3(0.90, 0.93, 1.0) * pow(max(dot(N, L), 0.0), 1.6) * 0.05;
  col *= 0.82 + 0.26 * abs(N.z);               // facets angled away sit back

  // A facet is one flat normal, so a sharp highlight lights the *entire* facet
  // at once rather than a spot on it. Without a rolloff that facet clips to
  // solid white and the stone reads as opaque plastic; the soft shoulder keeps
  // the bent starfield visible even through the brightest face.
  col = col / (1.0 + col * 0.62);

  fragColor = vec4(col, 1.0);
}`;

const SHARD_VERT = `#version 300 es
in vec3 position;
in vec3 normal;
in vec3 iOffset;
in vec3 iAxis;
in vec2 iScaleSpin;
in float iPhase;
in vec3 iTint;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform float uTime;
uniform float uSpreadX;
uniform vec2 uTilt;
out vec3 vNormal;
out vec3 vViewPos;
out vec3 vLight;
out vec3 vTint;
out float vAtten;

vec3 rotAxis(vec3 v, vec3 axis, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

void main() {
  vec3 axis = normalize(iAxis);
  float a = uTime * iScaleSpin.y + iPhase;

  // Spread only in X: the card is far wider than it is tall, and the field
  // should reach the corners at any aspect without stretching the shards.
  vec3 centre = vec3(iOffset.x * uSpreadX, iOffset.y, iOffset.z);
  centre.xy += uTilt * (iOffset.z + 2.2) * 0.055;   // depth parallax on pointer

  vec3 local = rotAxis(position * iScaleSpin.x, axis, a);
  vNormal = normalize(normalMatrix * rotAxis(normal, axis, a));

  // Lit from the origin — where the crystal is. Everything in this field owes
  // its visibility to that one source.
  vec3 toCentre = -centre;
  float d = max(length(toCentre), 0.001);
  // Gentler than inverse-square: true falloff leaves the corners of a wide card
  // completely unlit, and the field is meant to reach them.
  vAtten = 1.0 / (1.0 + 0.16 * d * d);
  vLight = normalize(normalMatrix * (toCentre / d));
  vTint = iTint;

  vec4 mv = modelViewMatrix * vec4(local + centre, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

/**
 * Shards have no body of their own: the shader outputs premultiplied colour with
 * an alpha built purely out of light terms — rim, specular, and transmission
 * through the far face. Where no light from the centre reaches a facet, alpha is
 * zero and the shard is simply not there.
 */
const SHARD_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBackdrop;
uniform vec2 uResolution;
uniform float uIOR;
uniform float uDispersion;
uniform float uStrength;
in vec3 vNormal;
in vec3 vViewPos;
in vec3 vLight;
in vec3 vTint;
in float vAtten;
out vec4 fragColor;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize(vLight);
  vec2 screen = gl_FragCoord.xy / uResolution;

  float facing = clamp(dot(N, V), 0.0, 1.0);
  float thick = mix(0.35, 1.25, 1.0 - facing);

  vec3 rR = refract(-V, N, 1.0 / (uIOR - uDispersion));
  vec3 rG = refract(-V, N, 1.0 / uIOR);
  vec3 rB = refract(-V, N, 1.0 / (uIOR + uDispersion));
  vec3 refracted = vec3(
    texture(uBackdrop, screen + rR.xy * uStrength * thick).r,
    texture(uBackdrop, screen + rG.xy * uStrength * thick).g,
    texture(uBackdrop, screen + rB.xy * uStrength * thick).b
  );

  // A steep exponent matters far more here than on the crystal: a shard is only
  // a few pixels across, so nearly every fragment on it is close to grazing. At
  // a shallow exponent the rim term covers the whole silhouette and the shard
  // flattens into a coloured chip.
  float fres = pow(1.0 - facing, 5.0);
  vec3 H = normalize(L + V);
  // Two lobes: a broad one so most shards catch *something* as they turn, and a
  // tight one for the flash. With only the tight lobe almost nothing fires at
  // this size and the field reads as dead grey chips.
  float ndh = max(dot(N, H), 0.0);
  float spec = pow(ndh, 22.0) * 0.55 + pow(ndh, 160.0) * 1.6;
  // Light entering the far side and coming out towards the eye — the term that
  // makes a clear shard visible at all.
  float trans = pow(max(dot(-N, L), 0.0), 2.4) * facing;

  // Weighted towards the two terms that read as glass — the rim and the
  // highlight — and away from a flat body, which would turn each shard into a
  // coloured sticker rather than something you are looking through.
  // Almost all of the alpha comes from the rim and the highlight. The
  // transmission term is kept small on purpose: weighted up it fills the whole
  // silhouette evenly, and a shard with a filled body is a paper cutout, not
  // glass. Capped below 1 so even the brightest facet stays see-through.
  float energy = vAtten * (fres * 0.45 + spec * 1.9 + trans * 0.14);
  float alpha = clamp(energy, 0.0, 0.72);

  // Mostly white — the hue is a wash carried by the light, not the shard's own
  // colour, which is what keeps the field reading as glass dust in a beam.
  vec3 tint = mix(vec3(1.0), vTint, 0.62);
  // The glint splits into colour the way a prism does, so each flash arrives
  // tinted rather than white.
  vec3 prism = 0.55 + 0.45 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + dot(N, L) * 1.4));
  // Weighted down: the sky behind a shard is almost black out at the corners,
  // so carrying much of it into the body only muddies the colour.
  vec3 col = refracted * alpha * 0.5;
  col += tint * (fres * 0.42 + trans * 0.12) * vAtten;
  col += mix(vec3(1.0, 0.97, 0.93), prism, 0.55) * spec * vAtten * 3.0;

  fragColor = vec4(col, alpha);   // premultiplied
}`;

export default function GlassGem() {
  const reduced = useStaticMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  // Pointer tilt, in normalised card coordinates.
  const tilt = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: Renderer | null = null;
    let gl: Renderer["gl"] | null = null;
    let raf: number | null = null;
    let ro: ResizeObserver | null = null;
    let visible = false;
    let disposed = false;
    let started = false;

    let camera: Camera | null = null;
    let backdrop: Mesh | null = null;
    let blit: Mesh | null = null;
    let gem: Mesh | null = null;
    let shards: Mesh[] = [];
    let target: RenderTarget | null = null;
    let t0 = 0;

    const draw = (ms: number) => {
      if (!renderer || !gl || !camera || !backdrop || !blit || !gem || !target) return;
      const time = (ms - t0) / 1000;
      (backdrop.program.uniforms.uTime as { value: number }).value = time;
      const res: [number, number] = [gl.canvas.width, gl.canvas.height];
      (backdrop.program.uniforms.uResolution as { value: number[] }).value = res;
      (gem.program.uniforms.uResolution as { value: number[] }).value = res;

      // Ease the pointer tilt so it glides instead of snapping.
      const s = tilt.current;
      s.x += (s.tx - s.x) * 0.06;
      s.y += (s.ty - s.y) * 0.06;

      for (const m of shards) {
        (m.program.uniforms.uTime as { value: number }).value = time;
        (m.program.uniforms.uResolution as { value: number[] }).value = res;
        (m.program.uniforms.uTilt as { value: number[] }).value = [s.x, -s.y];
      }

      gem.rotation.y = time * 0.42 + s.x * 0.6;
      gem.rotation.x = -0.32 + s.y * 0.35 + Math.sin(time * 0.33) * 0.08;
      gem.rotation.z = Math.sin(time * 0.21) * 0.12;

      // Pass 1: the sky, offscreen. Pass 2: the same sky to screen. Pass 3: the
      // crystal, sampling pass 1. Pass 4: the shards, additive over both.
      renderer.render({ scene: backdrop, camera, target });
      renderer.render({ scene: blit, camera });
      renderer.render({ scene: gem, camera, clear: false });
      for (const m of shards) renderer.render({ scene: m, camera, clear: false });
    };

    const loop = (ms: number) => {
      if (disposed || !visible) {
        raf = null;
        return;
      }
      draw(ms);
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (started || disposed) return;
      started = true;

      renderer = new Renderer({
        dpr: Math.min(window.devicePixelRatio || 1, 1.75),
        alpha: false,
        antialias: true,
      });
      gl = renderer.gl;
      gl.canvas.style.position = "absolute";
      gl.canvas.style.inset = "0";
      gl.canvas.style.display = "block";
      host.appendChild(gl.canvas);

      camera = new Camera(gl, { fov: 32, near: 0.1, far: 100 });
      camera.position.set(0, 0, 5.2);

      target = new RenderTarget(gl);

      const quad = () => new Plane(gl!, { width: 2, height: 2 });
      // Both fullscreen passes must leave the depth buffer alone. Their vertex
      // shader writes gl_Position.z = 0, which is *nearer* than the gem sitting
      // at z ≈ 5 — with depth writes on, the blit silently occludes the crystal.
      backdrop = new Mesh(gl, {
        geometry: quad(),
        program: new Program(gl, {
          vertex: BACKDROP_VERT,
          fragment: BACKDROP_FRAG,
          depthTest: false,
          depthWrite: false,
          uniforms: { uTime: { value: 0 }, uResolution: { value: [1, 1] } },
        }),
      });
      blit = new Mesh(gl, {
        geometry: quad(),
        program: new Program(gl, {
          vertex: BACKDROP_VERT,
          fragment: BLIT_FRAG,
          depthTest: false,
          depthWrite: false,
          uniforms: { uTexture: { value: target.texture } },
        }),
      });

      const cut = buildCrystal({ seed: 20260810 });
      gem = new Mesh(gl, {
        geometry: new Geometry(gl, {
          position: { size: 3, data: cut.position },
          normal: { size: 3, data: cut.normal },
        }),
        program: new Program(gl, {
          vertex: GEM_VERT,
          fragment: GEM_FRAG,
          cullFace: null, // both hull sides are wanted — it is glass
          uniforms: {
            uBackdrop: { value: target.texture },
            uResolution: { value: [1, 1] },
            uIOR: { value: 1.44 },
            // Dispersion is deliberately large next to the offset: the channel
            // split is what colours the edges, and it needs to out-read the
            // offset itself to be visible at this size.
            uDispersion: { value: 0.11 },
            // Screen-UV units — 0.24 flung samples a quarter of the canvas away,
            // which averaged into flat colour instead of bending anything.
            uStrength: { value: 0.16 },
            uLightDir: { value: [-0.5, 0.85, 0.7] },
            // Near-white with the faintest cool cast. A saturated rim colour
            // bleeds inwards across small facets and tints the whole stone.
            uEdge: { value: [0.88, 0.92, 1.0] },
          },
        }),
      });
      gem.scale.set(1.18);

      // One mesh per distinct shard cut, instanced across its share of the field.
      const fields = buildShardField(SHARD_SEEDS.length);
      const shardMeshes = SHARD_SEEDS.map((seed, i) => {
        const shard = buildCrystal({
          seed,
          cuts: 8,
          minOffset: 0.5,
          maxOffset: 1.2,
          stretch: [0.8 + i * 0.14, 1.5 - i * 0.2, 0.74],
        });
        const f = fields[i]!;
        return new Mesh(gl!, {
          geometry: new Geometry(gl!, {
            position: { size: 3, data: shard.position },
            normal: { size: 3, data: shard.normal },
            iOffset: { instanced: 1, size: 3, data: f.iOffset },
            iAxis: { instanced: 1, size: 3, data: f.iAxis },
            iScaleSpin: { instanced: 1, size: 2, data: f.iScaleSpin },
            iPhase: { instanced: 1, size: 1, data: f.iPhase },
            iTint: { instanced: 1, size: 3, data: f.iTint },
          }),
          program: new Program(gl!, {
            vertex: SHARD_VERT,
            fragment: SHARD_FRAG,
            cullFace: null,
            transparent: true,
            // Premultiplied additive-over: order-independent, so the shards need
            // no depth sort among themselves — but they still test against the
            // crystal's depth, so the ones behind it stay behind it.
            depthWrite: false,
            uniforms: {
              uBackdrop: { value: target!.texture },
              uResolution: { value: [1, 1] },
              uTime: { value: 0 },
              uSpreadX: { value: 2.4 },
              uTilt: { value: [0, 0] },
              uIOR: { value: 1.38 },
              uDispersion: { value: 0.13 },
              uStrength: { value: 0.05 },
            },
          }),
        });
      });
      for (const m of shardMeshes) {
        m.program.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      shards = shardMeshes;

      const resize = () => {
        if (!renderer || !gl || !camera) return;
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h);
        camera.perspective({ aspect: gl.canvas.width / gl.canvas.height });
        target?.setSize(gl.canvas.width, gl.canvas.height);
        // Reach the corners on a wide card without letting the field collapse
        // onto the crystal on a narrow one.
        const spread = Math.min(Math.max((w / Math.max(h, 1)) * 1.35, 1.5), 4.2);
        for (const m of shards) {
          (m.program.uniforms.uSpreadX as { value: number }).value = spread;
        }
      };
      resize();
      ro = new ResizeObserver(resize);
      ro.observe(host);

      t0 = performance.now();
      if (reduced) {
        // One settled frame, at an angle that shows the facets off.
        tilt.current = { x: 0.2, y: 0.1, tx: 0.2, ty: 0.1 };
        draw(t0 + 2200);
      } else {
        raf = requestAnimationFrame(loop);
      }
    };

    // Only claim a WebGL context once the card is actually on screen.
    const io = new IntersectionObserver(
      (entries) => {
        visible = !!entries[0]?.isIntersecting;
        if (visible && !started) start();
        else if (visible && started && raf == null && !reduced) raf = requestAnimationFrame(loop);
      },
      { rootMargin: "200px" }
    );
    io.observe(host);

    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      tilt.current.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      tilt.current.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    };
    const onLeave = () => {
      tilt.current.tx = 0;
      tilt.current.ty = 0;
    };
    // Listen on the card, not the canvas: the canvas is inside a
    // pointer-events-none visual slot in some layouts.
    const surface = host.parentElement ?? host;
    surface.addEventListener("pointermove", onMove);
    surface.addEventListener("pointerleave", onLeave);

    return () => {
      disposed = true;
      io.disconnect();
      ro?.disconnect();
      if (raf != null) cancelAnimationFrame(raf);
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerleave", onLeave);
      if (gl?.canvas.parentElement === host) host.removeChild(gl.canvas);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      shards = [];
      renderer = null;
      gl = null;
    };
  }, [reduced]);

  return (
    <div
      ref={hostRef}
      aria-hidden
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    />
  );
}
