"use client";

import { useEffect, useRef } from "react";
import { Camera, Geometry, Mesh, Plane, Program, Renderer, RenderTarget } from "ogl";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * GlassGem — a faceted crystal that bends the sky behind it.
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
 * sidesteps transparency sorting entirely.
 */

/**
 * A table-cut gem: flat top, crown facets down to a girdle band, then a pavilion
 * to a point. Non-indexed with per-triangle normals — flat shading is what makes
 * facets read as facets.
 */
function buildGem({
  sides = 6,
  r = 1,
  tableR = 0.6,
  crownH = 0.4,
  girdleH = 0.16,
  pavilionH = 0.95,
}) {
  const pos: number[] = [];
  const nrm: number[] = [];

  const ring = (radius: number, y: number, offset = 0) =>
    Array.from({ length: sides }, (_, i) => {
      const a = ((i + offset) / sides) * Math.PI * 2;
      return [Math.cos(a) * radius, y, Math.sin(a) * radius] as [number, number, number];
    });

  const table = ring(tableR, crownH, 0.5);
  const gTop = ring(r, girdleH / 2);
  const gBot = ring(r, -girdleH / 2);
  const apex: [number, number, number] = [0, -girdleH / 2 - pavilionH, 0];
  const tableC: [number, number, number] = [0, crownH, 0];

  const tri = (a: number[], b: number[], c: number[]) => {
    // Flat normal from the triangle's own plane.
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (const p of [a, b, c]) {
      pos.push(p[0]!, p[1]!, p[2]!);
      nrm.push(n[0]! / len, n[1]! / len, n[2]! / len);
    }
  };

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // Table
    tri(tableC, table[i]!, table[j]!);
    // Crown — each table edge fans out to two girdle vertices
    tri(table[i]!, gTop[i]!, gTop[j]!);
    tri(table[i]!, gTop[j]!, table[j]!);
    // Girdle band
    tri(gTop[i]!, gBot[i]!, gBot[j]!);
    tri(gTop[i]!, gBot[j]!, gTop[j]!);
    // Pavilion
    tri(gBot[j]!, gBot[i]!, apex);
  }

  return { position: new Float32Array(pos), normal: new Float32Array(nrm) };
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
  vec3 back = texture(uBackdrop, screen + refract(-V, -N, uIOR).xy * uStrength * 0.6).rgb;
  refracted = mix(refracted, back, 0.32);

  // Barely tinted: glass is mostly whatever is behind it.
  refracted *= mix(vec3(1.1), vec3(0.86, 0.82, 1.0), 1.0 - abs(dot(N, V)));

  // Grazing facets brighten; facets pointed at you stay clear.
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);

  // Fixed light, rotating gem → specular sweeps facet to facet as it turns.
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 140.0);

  vec3 col = refracted * 1.18;
  col += uEdge * fres * 0.44;                  // rim, kept off the broad facets
  col += vec3(1.0, 0.97, 0.92) * spec * 2.2;   // highlight
  col += vec3(0.55, 0.40, 1.0) * pow(max(dot(N, L), 0.0), 6.0) * 0.07;

  fragColor = vec4(col, 1.0);
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

      gem.rotation.y = time * 0.42 + s.x * 0.6;
      gem.rotation.x = -0.32 + s.y * 0.35 + Math.sin(time * 0.33) * 0.08;
      gem.rotation.z = Math.sin(time * 0.21) * 0.12;

      // Pass 1: the sky, offscreen. Pass 2: the same sky to screen. Pass 3: the
      // crystal, sampling pass 1.
      renderer.render({ scene: backdrop, camera, target });
      renderer.render({ scene: blit, camera });
      renderer.render({ scene: gem, camera, clear: false });
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

      const cut = buildGem({ sides: 6 });
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
            uStrength: { value: 0.12 },
            uLightDir: { value: [-0.5, 0.85, 0.7] },
            uEdge: { value: [0.72, 0.42, 1.0] },
          },
        }),
      });
      gem.scale.set(1.18);

      const resize = () => {
        if (!renderer || !gl || !camera) return;
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h);
        camera.perspective({ aspect: gl.canvas.width / gl.canvas.height });
        target?.setSize(gl.canvas.width, gl.canvas.height);
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
