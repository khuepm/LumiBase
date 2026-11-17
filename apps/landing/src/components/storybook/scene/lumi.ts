import * as THREE from "three";
import { createFlareTexture, createGlowTexture } from "./textures";

/**
 * Lumi — the LumiBase mascot, built procedurally so the page ships no model
 * file: a soft plush ball, a small face, and a gold antenna whose tip glows.
 *
 * The coat is velvet, not hair. An opaque core carries the colour and a sheen
 * that brightens toward the silhouette, the way flocked fabric catches light.
 * Over it, a few transparent shells of short, dense fuzz — each a little
 * further out and a little fainter — soften the outline into a halo without
 * ever resolving into separate strands.
 */

export interface LumiPose {
  /** Object-space velocity, already smoothed. Fur trails behind it. */
  velocity: THREE.Vector3;
  /** Where Lumi looks, each axis in -1..1 (x right, y up). */
  look: THREE.Vector2;
  /** 0..1 — brightness of the antenna tip and the warm wash it throws on the fur. */
  glow: number;
  /** 0..1 — warm light from below, for when Lumi hovers over the lamp. */
  underlight: number;
  /** 1 = resting, >1 stretched tall, <1 squashed flat. Volume is preserved. */
  stretch: number;
  /** Forces the eyes shut (a happy squint) regardless of the blink clock. */
  squint: boolean;
}

export interface Lumi {
  /** Place and scale this. Origin is the centre of the body. */
  readonly group: THREE.Group;
  /** World position of the antenna tip, for emitting sparkles. */
  tipWorld(target: THREE.Vector3): THREE.Vector3;
  /** Change the number of fur layers — the main cost of drawing Lumi. */
  setShells(count: number): void;
  update(dt: number, time: number, pose: LumiPose): void;
  dispose(): void;
}

const FUR_VERT = /* glsl */ `
  attribute float aShell;
  uniform float uBase;
  uniform float uFurLength;
  uniform float uTime;
  uniform vec3 uVelocity;
  varying vec3 vDir;
  varying float vShell;
  varying float vFace;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  const vec3 EYE_L = vec3(-0.3119, 0.0662, 0.9478);
  const vec3 EYE_R = vec3(0.3119, 0.0662, 0.9478);
  const vec3 MOUTH = vec3(0.0, -0.1387, 0.9903);

  void main() {
    vec3 n = normalize(position);
    vDir = n;
    vShell = aShell;

    // Thinner fuzz over the face, and none at all around the features, so the
    // eyes and smile stay crisp.
    float face = smoothstep(0.55, 0.97, n.z);
    float socket = max(
      max(smoothstep(0.955, 0.985, dot(n, EYE_L)), smoothstep(0.955, 0.985, dot(n, EYE_R))),
      smoothstep(0.965, 0.99, dot(n, MOUTH)));
    vFace = max(face * 0.55, socket);
    float len = uFurLength * mix(1.0, 0.6, face);

    // The nap lies a little downward and trails behind motion, like plush.
    float sway = sin(dot(n, vec3(1.7, 2.3, 1.1)) + uTime * 0.6) * 0.04;
    vec3 bend = vec3(sway, -0.12, 0.0) - uVelocity * 0.6;
    bend -= n * dot(bend, n);

    float h = aShell;
    vec3 p = n * (uBase + len * h) + bend * len * h * h;

    vec4 world = modelMatrix * vec4(p, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * n);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FUR_FRAG = /* glsl */ `
  uniform float uDensity;
  uniform float uOpacity;
  uniform vec3 uRoot;
  uniform vec3 uCoat;
  uniform vec3 uTip;
  uniform vec3 uBlush;
  uniform vec3 uWarm;
  uniform vec3 uRim;
  uniform vec3 uKeyDir;
  uniform float uGlow;
  uniform float uUnderlight;
  varying vec3 vDir;
  varying float vShell;
  varying float vFace;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  // Smooth value noise: soft blobs, never hard-edged cells or strands.
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
          mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
          mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = vShell;
    float nap = noise(d * uDensity) * 0.6 + noise(d * uDensity * 2.7 + 13.0) * 0.4;

  #ifdef FUZZ
    // Each shell keeps the soft high spots of the nap, fewer the further out
    // it sits, and fades with height — a tapering haze, not strands.
    float coverage = smoothstep(h * 0.6 - 0.15, h * 0.6 + 0.3, nap);
    float alpha = coverage * uOpacity * pow(1.0 - h, 1.4) * (1.0 - vFace);
    if (alpha < 0.004) discard;
    vec3 col = mix(uCoat, uTip, h);
  #else
    // Velvet core: barely-there mottling so it reads as fabric, not plastic.
    // A broad, soft tufting on top of the fine nap, like brushed plush.
    float tuft = noise(d * 9.0 + 3.0);
    vec3 col = mix(uRoot, uCoat, 0.55 + 0.25 * nap + 0.2 * tuft);
  #endif

    float cheekL = smoothstep(0.974, 0.996, dot(d, normalize(vec3(-0.58, -0.2, 0.79))));
    float cheekR = smoothstep(0.974, 0.996, dot(d, normalize(vec3(0.58, -0.2, 0.79))));
    col = mix(col, uBlush, max(cheekL, cheekR) * 0.5);

    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    float ndv = max(dot(N, V), 0.0);

    // Wrapped diffuse: plush never goes fully dark on the far side.
    float key = dot(N, normalize(uKeyDir)) * 0.5 + 0.5;
    key = key * key;
    vec3 lit = col * (0.46 + 0.72 * key);

    // Velvet sheen: fibres seen edge-on near the silhouette catch the light.
    float sheen = pow(1.0 - ndv, 2.2);
    lit += mix(uTip, uRim, 0.55) * sheen * 0.5;

    // The antenna tip washes the crown in warm light.
    float crown = smoothstep(0.2, 0.98, dot(d, normalize(vec3(0.16, 0.97, 0.12))));
    lit += uWarm * crown * crown * uGlow * 0.5;

    // Lamp light from below.
    float under = smoothstep(0.1, -0.9, N.y);
    lit += uWarm * under * uUnderlight * 0.38;

    // Held just under paper-white so the coat stays out of the bloom pass;
    // only the antenna is allowed to glow.
    vec3 outCol = min(lit * 0.86, vec3(0.98));
  #ifdef FUZZ
    gl_FragColor = vec4(outCol, alpha);
  #else
    gl_FragColor = vec4(outCol, 1.0);
  #endif
  }
`;

export function createLumi(options: { shells: number }): Lumi {
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const group = new THREE.Group();
  /** Squash-and-stretch and the head turn live here, under the placement group. */
  const body = new THREE.Group();
  group.add(body);

  // ── Coat ───────────────────────────────────────────────────────────────
  /** Radius of the velvet core; the fuzz sits on top of it. */
  const BASE = 1.12;
  const FUR_LENGTH = 0.2;
  const sphere = track(new THREE.SphereGeometry(1, 96, 64));

  const uniforms = {
    uBase: { value: BASE },
    uFurLength: { value: FUR_LENGTH },
    uDensity: { value: 150 },
    uOpacity: { value: 0.1 },
    uTime: { value: 0 },
    uVelocity: { value: new THREE.Vector3() },
    uRoot: { value: new THREE.Color("#e2d2bb") },
    uCoat: { value: new THREE.Color("#f4e9d6") },
    uTip: { value: new THREE.Color("#fff9ee") },
    uBlush: { value: new THREE.Color("#ff9fb6") },
    uWarm: { value: new THREE.Color("#ffb347") },
    uRim: { value: new THREE.Color("#a9b8ff") },
    uKeyDir: { value: new THREE.Vector3(-0.45, 0.7, 0.75) },
    uGlow: { value: 1 },
    uUnderlight: { value: 0 },
  };

  const shellGeometry = (levels: Float32Array) => {
    const geometry = track(new THREE.InstancedBufferGeometry());
    geometry.index = sphere.index;
    geometry.setAttribute("position", sphere.getAttribute("position"));
    const attribute = new THREE.InstancedBufferAttribute(levels, 1);
    geometry.setAttribute("aShell", attribute);
    geometry.instanceCount = levels.length;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BASE + FUR_LENGTH * 1.6);
    return { geometry, attribute };
  };

  // The opaque core: one shell at height 0. It writes depth, so the world
  // behind Lumi stays hidden.
  const core = new THREE.Mesh(
    shellGeometry(new Float32Array([0])).geometry,
    track(new THREE.ShaderMaterial({ vertexShader: FUR_VERT, fragmentShader: FUR_FRAG, uniforms })),
  );
  body.add(core);

  // The fuzz: transparent shells, drawn inside-out so each blends over the last.
  const MAX_SHELLS = 64;
  const shellLevels = new Float32Array(MAX_SHELLS);
  const { geometry: fuzzGeometry, attribute: shellAttribute } = shellGeometry(shellLevels);
  const fuzzMaterial = track(
    new THREE.ShaderMaterial({
      vertexShader: FUR_VERT,
      fragmentShader: FUR_FRAG,
      uniforms,
      defines: { FUZZ: 1 },
      transparent: true,
      depthWrite: false,
    }),
  );
  const fuzz = new THREE.Mesh(fuzzGeometry, fuzzMaterial);
  fuzz.renderOrder = 1;
  body.add(fuzz);

  /** Velvet needs half the layers strands did; quality rungs still scale it. */
  function setShells(count: number) {
    const shells = Math.max(4, Math.min(MAX_SHELLS, Math.round(count * 0.5)));
    for (let i = 0; i < shells; i++) shellLevels[i] = (i + 1) / shells;
    shellAttribute.needsUpdate = true;
    fuzzGeometry.instanceCount = shells;
    // The same total haze whatever the layer count.
    uniforms.uOpacity.value = 4.2 / shells;
  }
  setShells(options.shells);

  // ── Face ───────────────────────────────────────────────────────────────
  // Features sit just inside the fur tips so the coat frames them.
  const FACE_R = BASE + 0.012;
  const face = new THREE.Group();
  body.add(face);

  const onFace = (x: number, y: number) =>
    new THREE.Vector3(x, y, 1).normalize().multiplyScalar(FACE_R);

  const eyeMaterial = track(
    new THREE.MeshStandardMaterial({ color: "#0d0a0a", roughness: 0.12, metalness: 0.1 }),
  );
  const glintMaterial = track(new THREE.MeshBasicMaterial({ color: "#ffffff" }));
  const inkMaterial = track(new THREE.MeshBasicMaterial({ color: "#3b2416" }));
  const browMaterial = track(new THREE.MeshBasicMaterial({ color: "#9c7a55" }));

  const eyeGeometry = track(new THREE.SphereGeometry(0.08, 24, 18));
  const glintGeometry = track(new THREE.SphereGeometry(0.026, 12, 10));
  const lidGeometry = track(new THREE.TorusGeometry(0.085, 0.017, 8, 20, Math.PI));
  const browGeometry = track(new THREE.TorusGeometry(0.1, 0.012, 6, 16, Math.PI * 0.55));
  const smileGeometry = track(new THREE.TorusGeometry(0.105, 0.017, 8, 20, Math.PI * 0.72));

  const eyes: { open: THREE.Group; shut: THREE.Mesh }[] = [];
  for (const side of [-1, 1]) {
    const at = onFace(0.329 * side, 0.0698);
    const holder = new THREE.Group();
    holder.position.copy(at);
    holder.lookAt(at.clone().multiplyScalar(2));
    face.add(holder);

    const open = new THREE.Group();
    const ball = new THREE.Mesh(eyeGeometry, eyeMaterial);
    ball.scale.set(1, 1.16, 0.55);
    open.add(ball);
    const glint = new THREE.Mesh(glintGeometry, glintMaterial);
    glint.position.set(-0.026, 0.04, 0.04);
    open.add(glint);
    const glint2 = new THREE.Mesh(glintGeometry, glintMaterial);
    glint2.position.set(0.03, -0.03, 0.04);
    glint2.scale.setScalar(0.45);
    open.add(glint2);
    holder.add(open);

    // A closed eye is a little upward arc — the happy squint from the video.
    const shut = new THREE.Mesh(lidGeometry, inkMaterial);
    shut.visible = false;
    holder.add(shut);

    const brow = new THREE.Mesh(browGeometry, browMaterial);
    brow.position.set(0.01 * side, 0.2, 0);
    brow.rotation.z = Math.PI * 0.225 - side * 0.12;
    holder.add(brow);

    eyes.push({ open, shut });
  }

  const smile = new THREE.Mesh(smileGeometry, inkMaterial);
  const smileAt = onFace(0, -0.14);
  smile.position.copy(smileAt);
  smile.lookAt(smileAt.clone().multiplyScalar(2));
  smile.rotateZ(Math.PI + Math.PI * 0.14);
  face.add(smile);

  // ── Antenna ────────────────────────────────────────────────────────────
  const antenna = new THREE.Group();
  antenna.position.set(0.1, BASE + FUR_LENGTH * 0.2, 0.06);
  body.add(antenna);

  const TIP = new THREE.Vector3(0.2, 0.52, 0);
  const stem = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-0.02, 0.36, 0),
    TIP,
  );
  const gold = track(
    new THREE.MeshStandardMaterial({ color: "#f3b53a", roughness: 0.28, metalness: 1 }),
  );
  antenna.add(new THREE.Mesh(track(new THREE.TubeGeometry(stem, 20, 0.02, 8)), gold));

  const bulbMaterial = track(
    new THREE.MeshStandardMaterial({
      color: "#ffd77a",
      roughness: 0.2,
      metalness: 0.6,
      emissive: new THREE.Color("#ffb13b"),
      emissiveIntensity: 1.6,
    }),
  );
  const bulb = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 20, 16)), bulbMaterial);
  bulb.position.copy(TIP);
  antenna.add(bulb);

  const glowMap = track(createGlowTexture());
  const flareMap = track(createFlareTexture());
  const glowMaterial = track(
    new THREE.SpriteMaterial({
      map: glowMap,
      color: "#ffc978",
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  const flareMaterial = track(
    new THREE.SpriteMaterial({
      map: flareMap,
      color: "#fff0d0",
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.copy(TIP);
  antenna.add(glow);
  const flare = new THREE.Sprite(flareMaterial);
  flare.position.copy(TIP);
  antenna.add(flare);

  // ── Animation state ────────────────────────────────────────────────────
  let nextBlink = 1.6;
  let blinkUntil = -1;
  const antennaSpring = new THREE.Vector2();
  const antennaVelocity = new THREE.Vector2();

  function update(dt: number, time: number, pose: LumiPose) {
    uniforms.uTime.value = time;
    uniforms.uVelocity.value.copy(pose.velocity);
    uniforms.uGlow.value = pose.glow;
    uniforms.uUnderlight.value = pose.underlight;

    // Squash and stretch, volume-preserving, on top of a slow breath.
    const breath = 1 + Math.sin(time * 1.7) * 0.012;
    const stretch = pose.stretch * breath;
    const wide = 1 / Math.sqrt(stretch);
    body.scale.set(wide, stretch, wide);

    // Turn toward whatever Lumi is looking at.
    body.rotation.y = THREE.MathUtils.damp(body.rotation.y, pose.look.x * 0.5, 5, dt);
    body.rotation.x = THREE.MathUtils.damp(body.rotation.x, -pose.look.y * 0.32, 5, dt);
    body.rotation.z = Math.sin(time * 0.9) * 0.03 - pose.velocity.x * 0.25;

    // Blink on an irregular clock; a squint overrides it.
    if (time > nextBlink) {
      blinkUntil = time + 0.13;
      nextBlink = time + 2.2 + Math.random() * 3.4;
    }
    const closed = pose.squint || time < blinkUntil;
    for (const eye of eyes) {
      eye.open.visible = !closed;
      eye.shut.visible = closed;
    }

    // The antenna is a damped spring driven by the body's motion.
    const stiffness = 60;
    const damping = 7;
    antennaVelocity.x += (-stiffness * antennaSpring.x - damping * antennaVelocity.x - pose.velocity.x * 90) * dt;
    antennaVelocity.y += (-stiffness * antennaSpring.y - damping * antennaVelocity.y - pose.velocity.y * 60) * dt;
    antennaSpring.addScaledVector(antennaVelocity, dt);
    antennaSpring.clampScalar(-0.9, 0.9);
    antenna.rotation.z = -antennaSpring.x + Math.sin(time * 1.3) * 0.05;
    antenna.rotation.x = antennaSpring.y * 0.6;

    // The tip breathes and occasionally flashes.
    const pulse = 0.82 + Math.sin(time * 3.1) * 0.1 + Math.sin(time * 7.3) * 0.05;
    const g = pose.glow * pulse;
    bulbMaterial.emissiveIntensity = 0.5 + 2.2 * g;
    glow.scale.setScalar(0.42 + 0.5 * g);
    glowMaterial.opacity = 0.35 + 0.65 * g;
    flare.scale.setScalar(0.5 + 0.9 * g);
    flareMaterial.opacity = 0.25 + 0.75 * g;
    flareMaterial.rotation = time * 0.25;
  }

  return {
    group,
    tipWorld: (target) => bulb.getWorldPosition(target),
    setShells,
    update,
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}
