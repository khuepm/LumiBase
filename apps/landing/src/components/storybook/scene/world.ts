import * as THREE from "three";

/**
 * The stage: night sky, stars, a crescent moon, paper-cut hills with a castle
 * on the horizon, and the lamp. Everything is procedural — shaders and lathed
 * geometry — so the page downloads no textures or models for it.
 */

type Disposable = { dispose(): void };

/** Height of a hill's ridge at world x. Mirrored in GLSL by HILL_GLSL. */
export interface HillShape {
  base: number;
  a1: number;
  f1: number;
  p1: number;
  a2: number;
  f2: number;
  p2: number;
}
export function hillHeight(shape: HillShape, x: number): number {
  return (
    shape.base +
    shape.a1 * Math.sin(x * shape.f1 + shape.p1) +
    shape.a2 * Math.sin(x * shape.f2 + shape.p2)
  );
}

const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return v;
  }
`;

// ── Sky ────────────────────────────────────────────────────────────────────

export interface Sky {
  mesh: THREE.Mesh;
  update(time: number, altitude: number, aspect: number, glow: THREE.Vector2, glowAmount: number): void;
}

export function createSky(track: <T extends Disposable>(item: T) => T): Sky {
  const material = track(
    new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAltitude: { value: 0 },
        uAspect: { value: 1 },
        uGlow: { value: new THREE.Vector2() },
        uGlowAmount: { value: 0 },
        // Dusk at ground level: indigo overhead sinking to a plum horizon.
        uDuskTop: { value: new THREE.Color("#0b0a26") },
        uDuskMid: { value: new THREE.Color("#241655") },
        uDuskLow: { value: new THREE.Color("#5b2b68") },
        // Up among the stars: near black with a violet floor.
        uDeepTop: { value: new THREE.Color("#04030d") },
        uDeepMid: { value: new THREE.Color("#0d0a2a") },
        uDeepLow: { value: new THREE.Color("#1c1246") },
        uNebulaA: { value: new THREE.Color("#5a3bd6") },
        uNebulaB: { value: new THREE.Color("#1fa7a0") },
        uWarm: { value: new THREE.Color("#ff9d4d") },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uAltitude;
        uniform float uAspect;
        uniform vec2 uGlow;
        uniform float uGlowAmount;
        uniform vec3 uDuskTop, uDuskMid, uDuskLow;
        uniform vec3 uDeepTop, uDeepMid, uDeepLow;
        uniform vec3 uNebulaA, uNebulaB, uWarm;
        varying vec2 vUv;
        ${NOISE_GLSL}
        void main() {
          float y = vUv.y;
          vec3 top = mix(uDuskTop, uDeepTop, uAltitude);
          vec3 mid = mix(uDuskMid, uDeepMid, uAltitude);
          vec3 low = mix(uDuskLow, uDeepLow, uAltitude);
          vec3 col = mix(low, mid, smoothstep(0.0, 0.5, y));
          col = mix(col, top, smoothstep(0.4, 1.0, y));

          // Two slow drifts of colour so the dark is never flat.
          vec2 p = vec2(vUv.x * uAspect, y);
          float n1 = fbm(p * 1.6 + vec2(uTime * 0.008, uAltitude * 0.4));
          float n2 = fbm(p * 2.3 + vec2(-uTime * 0.006, 4.0 + uAltitude * 0.6));
          float band = smoothstep(0.42, 0.85, n1);
          col += uNebulaA * band * band * (0.1 + 0.16 * uAltitude);
          col += uNebulaB * smoothstep(0.5, 1.0, n2) * (0.02 + 0.045 * uAltitude);

          // The lamp lights the air around it.
          vec2 d = (vUv * 2.0 - 1.0 - uGlow) * vec2(uAspect, 1.0);
          float halo = exp(-dot(d, d) * 2.4);
          col += uWarm * halo * 0.3 * uGlowAmount;

          // Dither to keep the long gradients from banding.
          col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(2, 2)), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  return {
    mesh,
    update(time, altitude, aspect, glow, glowAmount) {
      material.uniforms.uTime!.value = time;
      material.uniforms.uAltitude!.value = altitude;
      material.uniforms.uAspect!.value = aspect;
      (material.uniforms.uGlow!.value as THREE.Vector2).copy(glow);
      material.uniforms.uGlowAmount!.value = glowAmount;
    },
  };
}

// ── Stars ──────────────────────────────────────────────────────────────────

export interface Stars {
  points: THREE.Points;
  update(time: number, pixelRatio: number, brightness: number): void;
}

export function createStars(count: number, track: <T extends Disposable>(item: T) => T): Stars {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  // A deterministic generator: the sky should not reshuffle on every reload.
  let state = 0x2f6e2b1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() * 2 - 1) * 46;
    positions[i * 3 + 1] = (random() * 2 - 1) * 26 + 6;
    positions[i * 3 + 2] = -18 - random() * 22;
    const r = random();
    seeds[i * 3] = 0.6 + r * r * r * 3.4; // mostly small, a few bright
    seeds[i * 3 + 1] = random() * 6.2832;
    seeds[i * 3 + 2] = random();
  }
  const geometry = track(new THREE.BufferGeometry());
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
  const material = track(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uBrightness: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vTwinkle;
        varying float vTint;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float twinkle = 0.62 + 0.38 * sin(uTime * (0.6 + aSeed.z * 1.8) + aSeed.y);
          vTwinkle = twinkle;
          vTint = aSeed.z;
          gl_PointSize = aSeed.x * uPixelRatio * (1.4 + twinkle);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uBrightness;
        varying float vTwinkle;
        varying float vTint;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float core = smoothstep(0.5, 0.0, d);
          vec3 cool = vec3(0.72, 0.8, 1.0);
          vec3 warm = vec3(1.0, 0.86, 0.66);
          vec3 col = mix(cool, warm, smoothstep(0.55, 1.0, vTint));
          gl_FragColor = vec4(col * 1.5, core * core * vTwinkle * uBrightness);
        }
      `,
    }),
  );
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    points,
    update(time, pixelRatio, brightness) {
      material.uniforms.uTime!.value = time;
      material.uniforms.uPixelRatio!.value = pixelRatio;
      material.uniforms.uBrightness!.value = brightness;
    },
  };
}

// ── Moon ───────────────────────────────────────────────────────────────────

export function createMoon(track: <T extends Disposable>(item: T) => T): THREE.Mesh {
  const material = track(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // Additive, so the moon only ever adds light. With normal blending the
      // faint earthshine disc darkened whatever sat behind it, and a dark
      // circle showed wherever the moon crossed Lumi's fuzz.
      blending: THREE.AdditiveBlending,
      uniforms: {
        uLit: { value: new THREE.Color("#fff3d6") },
        uHalo: { value: new THREE.Color("#b9a8ff") },
        uOpacity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv * 2.0 - 1.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uLit;
        uniform vec3 uHalo;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float r = 0.36;
          float d = length(vUv);
          float disc = smoothstep(r, r - 0.012, d);
          // A second disc, offset, bites the crescent out of the first.
          float bite = smoothstep(r * 0.9, r * 0.9 - 0.02, length(vUv - vec2(0.17, 0.09)));
          float crescent = disc * (1.0 - bite);
          float earthshine = disc * bite * 0.025;
          float halo = exp(-max(d - r * 0.75, 0.0) * 7.0) * 0.16;
          vec3 col = uLit * crescent * 1.25 + uLit * earthshine + uHalo * halo;
          float alpha = clamp(crescent + earthshine * 4.0 + halo, 0.0, 1.0);
          gl_FragColor = vec4(col, alpha * uOpacity);
        }
      `,
    }),
  );
  const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), material);
  mesh.renderOrder = -50;
  return mesh;
}

// ── Hills ──────────────────────────────────────────────────────────────────

export interface HillLayer {
  mesh: THREE.Mesh;
  shape: HillShape;
  z: number;
  /** Re-fit the layer to the viewport: `bottom` is the world y of the screen's lower edge at this depth. */
  fit(halfWidth: number, bottom: number, rise: number): void;
  /** Where the castle stands, as a fraction of the half-width at this depth. */
  setCastle(x: number): void;
  setGlow(x: number, amount: number): void;
}

interface HillStyle {
  z: number;
  /** Ridge height above the bottom of the screen, as a fraction of the screen's height at this depth. */
  lift: number;
  /** Ridge undulation, same unit. */
  sway: number;
  f1: number;
  p1: number;
  f2: number;
  p2: number;
  body: string;
  rim: string;
  castle: boolean;
}

const HILL_STYLES: readonly HillStyle[] = [
  { z: -9, lift: 0.36, sway: 0.035, f1: 0.21, p1: 1.3, f2: 0.47, p2: 0.4, body: "#2a1a58", rim: "#8f79e8", castle: true },
  { z: -4.5, lift: 0.27, sway: 0.04, f1: 0.33, p1: 4.1, f2: 0.71, p2: 2.2, body: "#1c1142", rim: "#6f58cf", castle: false },
  { z: 0, lift: 0.17, sway: 0.03, f1: 0.52, p1: 0.6, f2: 1.13, p2: 5.0, body: "#120a2e", rim: "#5a45b8", castle: false },
];

export function createHills(track: <T extends Disposable>(item: T) => T): HillLayer[] {
  const geometry = track(new THREE.PlaneGeometry(1, 1));
  return HILL_STYLES.map((style) => {
    const shape: HillShape = { base: 0, a1: 0, f1: style.f1, p1: style.p1, a2: 0, f2: style.f2, p2: style.p2 };
    const material = track(
      new THREE.ShaderMaterial({
        transparent: true,
        uniforms: {
          uShape: { value: new THREE.Vector3() }, // base, a1, a2
          uFreq: { value: new THREE.Vector4(style.f1, style.p1, style.f2, style.p2) },
          uBody: { value: new THREE.Color(style.body) },
          uRim: { value: new THREE.Color(style.rim) },
          uWarm: { value: new THREE.Color("#ffab57") },
          uGlow: { value: new THREE.Vector2(0, 0) }, // x, amount
          uCastle: { value: style.castle ? 1 : 0 },
          uCastleX: { value: 0 },
          uUnit: { value: 1 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uShape;
          uniform vec4 uFreq;
          uniform vec3 uBody, uRim, uWarm;
          uniform vec2 uGlow;
          uniform float uCastle;
          uniform float uCastleX;
          uniform float uUnit;
          varying vec3 vWorld;

          float ridge(float x) {
            return uShape.x + uShape.y * sin(x * uFreq.x + uFreq.y) + uShape.z * sin(x * uFreq.z + uFreq.w);
          }
          // A tower: a rectangular body under a pointed roof. Returns 1 inside.
          float tower(vec2 p, float halfWidth, float height, float roof) {
            float body = step(abs(p.x), halfWidth) * step(0.0, p.y) * step(p.y, height);
            float t = (p.y - height) / roof;
            float cone = step(0.0, t) * step(t, 1.0) * step(abs(p.x), (halfWidth + 0.035) * (1.0 - t));
            return max(body, cone);
          }

          void main() {
            float ground = ridge(vWorld.x);
            float inside = smoothstep(ground + 0.02, ground - 0.02, vWorld.y);
            vec3 col = uBody;
            float lit = 0.0;

            if (uCastle > 0.5) {
              // Castle coordinates: the tallest spire is about 4.4 units, and one
              // unit is 4% of the screen height.
              float cu = uUnit * 0.4;
              vec2 p = vec2(vWorld.x - uCastleX, vWorld.y - ridge(uCastleX) + 0.3 * cu) / cu;
              float keep = tower(p, 0.5, 1.5, 0.0);
              float c = max(keep, tower(p - vec2(-0.72, 0.0), 0.2, 2.1, 0.75));
              c = max(c, tower(p - vec2(0.7, 0.0), 0.2, 2.5, 0.85));
              c = max(c, tower(p - vec2(0.0, 0.0), 0.26, 3.25, 1.1));
              c = max(c, tower(p - vec2(-1.25, 0.0), 0.15, 1.35, 0.6));
              c = max(c, tower(p - vec2(1.22, 0.0), 0.15, 1.6, 0.65));
              // Battlements along the curtain wall.
              float teeth = step(0.5, fract(p.x * 3.2)) * step(abs(p.x), 0.5) * step(1.5, p.y) * step(p.y, 1.66);
              c = max(c, teeth);
              inside = max(inside, c);
              // A few lit windows — small enough to bloom into points.
              vec2 w1 = abs(p - vec2(0.0, 2.55)) - vec2(0.07, 0.13);
              vec2 w2 = abs(p - vec2(0.7, 1.9)) - vec2(0.055, 0.1);
              vec2 w3 = abs(p - vec2(-0.72, 1.5)) - vec2(0.055, 0.1);
              vec2 w4 = abs(p - vec2(0.22, 0.85)) - vec2(0.06, 0.11);
              vec2 w5 = abs(p - vec2(-0.2, 0.85)) - vec2(0.06, 0.11);
              lit = max(max(step(max(w1.x, w1.y), 0.0), step(max(w2.x, w2.y), 0.0)),
                        max(step(max(w3.x, w3.y), 0.0), max(step(max(w4.x, w4.y), 0.0), step(max(w5.x, w5.y), 0.0))));
            }
            if (inside < 0.01) discard;

            // Moonlight along the ridge, fading down the slope.
            float depth = ground - vWorld.y;
            col = mix(col, uRim, smoothstep(0.5 * uUnit, 0.0, depth) * 0.55);
            col = mix(col, uBody * 0.55, smoothstep(0.0, 6.0 * uUnit, depth));
            // The lamp warms the ground it stands on.
            float near = exp(-pow((vWorld.x - uGlow.x) / (2.6 * uUnit), 2.0)) * smoothstep(3.0 * uUnit, 0.0, depth);
            col += uWarm * near * uGlow.y * 0.55;
            col = mix(col, vec3(1.0, 0.78, 0.42) * 2.6, lit);
            gl_FragColor = vec4(col, inside);
          }
        `,
      }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -40 + style.z * -0.1;
    mesh.frustumCulled = false;
    let fittedHalfWidth = 1;
    return {
      mesh,
      shape,
      z: style.z,
      fit(halfWidth, bottom, rise) {
        const screen = -bottom * 2; // screen height in world units at this depth
        shape.base = bottom + screen * style.lift;
        shape.a1 = screen * style.sway;
        shape.a2 = screen * style.sway * 0.45;
        (material.uniforms.uShape!.value as THREE.Vector3).set(shape.base, shape.a1, shape.a2);
        material.uniforms.uUnit!.value = screen * 0.1;
        fittedHalfWidth = halfWidth;
        // Tall enough to cover everything below the ridge even once the camera
        // has risen `rise` world units above it.
        const height = screen * 1.2 + rise;
        mesh.scale.set(halfWidth * 2.6, height, 1);
        mesh.position.set(0, shape.base + screen * 0.45 - height / 2, style.z);
      },
      setCastle(x) {
        material.uniforms.uCastleX!.value = x * fittedHalfWidth;
      },
      setGlow(x, amount) {
        (material.uniforms.uGlow!.value as THREE.Vector2).set(x, amount);
      },
    };
  });
}

// ── Lamp ───────────────────────────────────────────────────────────────────

export interface Lamp {
  group: THREE.Group;
  /** World position of the spout's mouth — where wishes come out. */
  spoutWorld(target: THREE.Vector3): THREE.Vector3;
  setGlow(amount: number): void;
}

/** A tube whose radius changes along its length. */
function taperedTube(
  curve: THREE.Curve<THREE.Vector3>,
  segments: number,
  radial: number,
  radius: (t: number) => number,
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, point);
    const N = frames.normals[i]!;
    const B = frames.binormals[i]!;
    const r = radius(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      normal.set(0, 0, 0).addScaledVector(N, Math.cos(a)).addScaledVector(B, Math.sin(a)).normalize();
      positions.push(point.x + normal.x * r, point.y + normal.y * r, point.z + normal.z * r);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

export function createLamp(
  glowMap: THREE.Texture,
  track: <T extends Disposable>(item: T) => T,
): Lamp {
  const group = new THREE.Group();
  const gold = track(
    new THREE.MeshStandardMaterial({
      color: "#e9a93a",
      roughness: 0.3,
      metalness: 1,
      emissive: new THREE.Color("#7a3c08"),
      emissiveIntensity: 0.15,
    }),
  );
  const trim = track(
    new THREE.MeshStandardMaterial({ color: "#ffd98a", roughness: 0.22, metalness: 1 }),
  );

  // Body: foot, stem, a wide low bowl, a lid and its finial — one profile, lathed.
  const profile = [
    [0, 0], [0.36, 0], [0.4, 0.03], [0.38, 0.07], [0.2, 0.13], [0.15, 0.2], [0.17, 0.27],
    [0.36, 0.32], [0.62, 0.43], [0.74, 0.58], [0.7, 0.72], [0.52, 0.84], [0.3, 0.9],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.Mesh(track(new THREE.LatheGeometry(profile, 48)), gold);
  body.scale.set(1.28, 1, 0.92); // longer along the spout–handle axis
  group.add(body);

  const lidProfile = [
    [0.3, 0.9], [0.33, 0.93], [0.26, 0.97], [0.14, 1.04], [0.06, 1.09], [0.05, 1.13],
    [0.1, 1.17], [0.1, 1.22], [0.05, 1.27], [0, 1.28],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const lid = new THREE.Mesh(track(new THREE.LatheGeometry(lidProfile, 32)), trim);
  lid.scale.set(1.28, 1, 0.92);
  group.add(lid);

  // A band around the bowl's widest point.
  const band = new THREE.Mesh(track(new THREE.TorusGeometry(0.745, 0.022, 8, 48)), trim);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.6;
  band.scale.set(1.28, 0.92, 1);
  group.add(band);

  // Spout: swells out of the bowl and narrows as it rises to the left.
  const MOUTH = new THREE.Vector3(-1.72, 1.02, 0);
  const spoutCurve = new THREE.CubicBezierCurve3(
    new THREE.Vector3(-0.62, 0.5, 0),
    new THREE.Vector3(-1.15, 0.42, 0),
    new THREE.Vector3(-1.38, 0.7, 0),
    MOUTH,
  );
  const spout = new THREE.Mesh(
    track(taperedTube(spoutCurve, 28, 16, (t) => 0.26 - 0.17 * Math.pow(t, 0.8))),
    gold,
  );
  group.add(spout);
  const lip = new THREE.Mesh(track(new THREE.TorusGeometry(0.1, 0.025, 8, 20)), trim);
  lip.position.copy(MOUTH);
  lip.lookAt(MOUTH.clone().add(spoutCurve.getTangentAt(1)));
  group.add(lip);

  // Handle: an open loop on the right.
  const handleCurve = new THREE.CubicBezierCurve3(
    new THREE.Vector3(0.78, 0.74, 0),
    new THREE.Vector3(1.5, 1.05, 0),
    new THREE.Vector3(1.55, 0.2, 0),
    new THREE.Vector3(0.82, 0.4, 0),
  );
  group.add(
    new THREE.Mesh(
      track(taperedTube(handleCurve, 28, 10, (t) => 0.05 + 0.02 * Math.sin(t * Math.PI))),
      trim,
    ),
  );

  // Light spilling from the spout.
  const glowMaterial = track(
    new THREE.SpriteMaterial({
      map: glowMap,
      color: "#ffb65c",
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.copy(MOUTH).add(new THREE.Vector3(-0.06, 0.06, 0.1));
  group.add(glow);

  // Turned a little toward the reader so it is not a flat profile.
  group.rotation.y = -0.32;

  const scratch = new THREE.Vector3();
  return {
    group,
    spoutWorld(target) {
      return group.localToWorld(target.copy(MOUTH).add(scratch.set(-0.05, 0.06, 0)));
    },
    setGlow(amount) {
      glow.scale.setScalar(0.5 + 1.3 * amount);
      glowMaterial.opacity = 0.2 + 0.8 * amount;
      gold.emissiveIntensity = 0.08 + 0.22 * amount;
    },
  };
}

// ── Sparkles ───────────────────────────────────────────────────────────────

export interface Sparkles {
  points: THREE.Points;
  emit(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    life: number,
    size: number,
    color: THREE.Color,
  ): void;
  update(dt: number, time: number, pixelScale: number): void;
  clear(): void;
}

/**
 * A small CPU particle pool. A few hundred points at most, so updating them in
 * JS and re-uploading is cheaper than it is worth to avoid.
 */
export function createSparkles(capacity: number, track: <T extends Disposable>(item: T) => T): Sparkles {
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const look = new Float32Array(capacity * 2); // size, alpha
  const velocities = new Float32Array(capacity * 3);
  const ages = new Float32Array(capacity);
  const lives = new Float32Array(capacity);
  const sizes = new Float32Array(capacity);
  const seeds = new Float32Array(capacity);
  let cursor = 0;

  const geometry = track(new THREE.BufferGeometry());
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colorAttribute = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
  const lookAttribute = new THREE.BufferAttribute(look, 2).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("aColor", colorAttribute);
  geometry.setAttribute("aLook", lookAttribute);

  const material = track(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute vec2 aLook;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aLook.x * uScale / -mv.z;
          vColor = aColor;
          vAlpha = aLook.y;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          // A bright core with four short rays — a storybook twinkle.
          float core = smoothstep(0.5, 0.0, d);
          float rays = max(
            (1.0 - abs(c.x) * 2.0) * exp(-abs(c.y) * 22.0),
            (1.0 - abs(c.y) * 2.0) * exp(-abs(c.x) * 22.0));
          float a = clamp(core * core * core + rays * 0.8, 0.0, 1.0) * vAlpha;
          gl_FragColor = vec4(vColor * 2.2, a);
        }
      `,
    }),
  );
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 20;

  return {
    points,
    emit(position, velocity, life, size, color) {
      const i = cursor;
      cursor = (cursor + 1) % capacity;
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      velocities[i * 3] = velocity.x;
      velocities[i * 3 + 1] = velocity.y;
      velocities[i * 3 + 2] = velocity.z;
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      ages[i] = 0;
      lives[i] = life;
      sizes[i] = size;
      seeds[i] = Math.random() * 6.2832;
    },
    update(dt, time, pixelScale) {
      material.uniforms.uScale!.value = pixelScale;
      const drag = Math.exp(-1.4 * dt);
      for (let i = 0; i < capacity; i++) {
        const life = lives[i]!;
        if (life <= 0) {
          look[i * 2 + 1] = 0;
          continue;
        }
        const age = ages[i]! + dt;
        ages[i] = age;
        if (age >= life) {
          lives[i] = 0;
          look[i * 2 + 1] = 0;
          continue;
        }
        velocities[i * 3] = velocities[i * 3]! * drag;
        velocities[i * 3 + 1] = velocities[i * 3 + 1]! * drag + 0.25 * dt; // sparks drift upward
        velocities[i * 3 + 2] = velocities[i * 3 + 2]! * drag;
        positions[i * 3] = positions[i * 3]! + velocities[i * 3]! * dt;
        positions[i * 3 + 1] = positions[i * 3 + 1]! + velocities[i * 3 + 1]! * dt;
        positions[i * 3 + 2] = positions[i * 3 + 2]! + velocities[i * 3 + 2]! * dt;
        const t = age / life;
        const fade = Math.min(1, t * 8) * (1 - t) * (1 - t);
        const twinkle = 0.65 + 0.35 * Math.sin(time * 9 + seeds[i]!);
        look[i * 2] = sizes[i]! * (0.6 + 0.4 * (1 - t));
        look[i * 2 + 1] = fade * twinkle;
      }
      positionAttribute.needsUpdate = true;
      colorAttribute.needsUpdate = true;
      lookAttribute.needsUpdate = true;
    },
    clear() {
      lives.fill(0);
      look.fill(0);
      lookAttribute.needsUpdate = true;
    },
  };
}
