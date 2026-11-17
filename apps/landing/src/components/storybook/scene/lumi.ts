import * as THREE from "three";
import { createFlareTexture, createGlowTexture } from "./textures";

/**
 * Lumi — the LumiBase mascot, built procedurally so the page ships no model
 * file: a pom-pom of shell-textured fur, a small face, and a gold antenna whose
 * tip glows.
 *
 * Fur is "shell texturing": the same sphere is drawn `shells` times, each copy
 * pushed a little further along its normal, and the fragment shader keeps only
 * the texels that fall inside a strand. Every shell looks a strand up by its
 * *unbent* direction, so a strand is the same texel on every layer and reads as
 * one continuous hair even after the vertex shader bends the layers sideways.
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
  uniform float uFurLength;
  uniform float uTime;
  uniform vec3 uVelocity;
  varying vec3 vDir;
  varying float vShell;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  // Cheap value noise — only used for the lazy, low-frequency sway.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
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

  const vec3 EYE_L = vec3(-0.3119, 0.0662, 0.9478);
  const vec3 EYE_R = vec3(0.3119, 0.0662, 0.9478);
  const vec3 MOUTH = vec3(0.0, -0.1387, 0.9903);

  void main() {
    vec3 n = normalize(position);
    vDir = n;
    vShell = aShell;

    // Shorter fur over the face so the eyes and mouth are not buried.
    float face = smoothstep(0.5, 0.97, n.z);
    float len = uFurLength * mix(1.0, 0.74, face);
    // ...and shorter still in a small socket around each feature.
    float socket = max(
      max(smoothstep(0.972, 0.994, dot(n, EYE_L)), smoothstep(0.972, 0.994, dot(n, EYE_R))),
      smoothstep(0.976, 0.996, dot(n, MOUTH)));
    len *= mix(1.0, 0.42, socket);

    // The coat parts from a whorl on the forehead and lies away from it, which
    // is what makes a pom-pom read as combed rather than as static.
    vec3 whorl = normalize(vec3(0.0, 0.72, 0.69));
    vec3 away = n - whorl * dot(n, whorl);
    away = away / max(length(away), 1e-3);

    // Clumps: neighbouring strands lean the same way.
    vec3 clump = vec3(
      noise(n * 4.3 + 11.0),
      noise(n * 4.3 + 37.0),
      noise(n * 4.3 + 71.0)) - 0.5;

    float sway = noise(n * 2.0 + vec3(0.0, uTime * 0.35, 0.0)) - 0.5;

    vec3 bend = away * 0.34
      + clump * 0.9
      + vec3(0.0, -0.3, 0.0)
      + vec3(sway * 0.22, 0.0, sway * 0.16)
      - uVelocity;
    // Keep the bend mostly sideways; a strand should lean, not retract.
    bend -= n * dot(bend, n) * 0.7;

    float h = aShell;
    vec3 p = n * (1.0 + len * h) + bend * len * h * h;

    vec4 world = modelMatrix * vec4(p, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normalize(n + bend * h * 0.6));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FUR_FRAG = /* glsl */ `
  uniform float uDensity;
  uniform float uShellStep;
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
  varying vec3 vNormalW;
  varying vec3 vPosW;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  // The strand lattice is tilted off the axes so no face of it ever lines up
  // with the camera and shows as a grid.
  const mat3 LATTICE = mat3(
    0.6124, 0.6124, -0.5,
    -0.3536, 0.7866, 0.5303,
    0.7071, -0.0795, 0.6844);

  void main() {
    vec3 q = (LATTICE * vDir) * uDensity;
    vec3 cell = floor(q);
    vec3 jitter = hash33(cell);
    vec3 f = fract(q) - 0.5 - (jitter - 0.5) * 0.55;
    float rnd = jitter.x;
    float rnd2 = jitter.y;

    // Each strand has its own length; past its tip the texel is empty.
    float strand = mix(0.42, 1.0, rnd * rnd);
    // Shells are discrete layers; at grazing angles their edges line up into
    // contour bands. Nudging each fragment's height by under one layer breaks
    // the bands into grain, which reads as fluff.
    float grain = hash13(vec3(gl_FragCoord.xy, 7.0)) - 0.5;
    float height = vShell + grain * uShellStep;
    float taper = 1.0 - height / strand;
    if (vShell > 0.0 && (taper < 0.0 || length(f) > mix(0.1, 0.7, taper))) discard;

    // Roots sit in the shadow of the coat above them.
    float depth = vShell;
    vec3 col = mix(uRoot, uCoat, smoothstep(0.0, 0.45, depth));
    col = mix(col, uTip, smoothstep(0.5, 1.0, depth) * 0.8);
    col *= 0.92 + 0.16 * rnd2;

    // Dyed cheeks, strongest mid-strand like a real blush on plush.
    vec3 d = normalize(vDir);
    float cheekL = smoothstep(0.974, 0.996, dot(d, normalize(vec3(-0.58, -0.2, 0.79))));
    float cheekR = smoothstep(0.974, 0.996, dot(d, normalize(vec3(0.58, -0.2, 0.79))));
    col = mix(col, uBlush, max(cheekL, cheekR) * (0.38 + 0.3 * depth));

    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);

    // Wrapped diffuse: plush never goes fully dark on the far side.
    float key = dot(N, normalize(uKeyDir)) * 0.5 + 0.5;
    key = key * key;
    vec3 lit = col * (0.56 + 0.62 * key);

    // Moonlight catches the silhouette, where strands are seen edge-on.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 2.4);
    lit += uRim * fres * (0.25 + 0.75 * depth) * 0.7;

    // The antenna tip washes the crown in warm light.
    float crown = smoothstep(0.2, 0.98, dot(d, normalize(vec3(0.16, 0.97, 0.12))));
    lit += uWarm * crown * crown * uGlow * (0.35 + 0.65 * depth);

    // Lamp light from below.
    float under = smoothstep(0.1, -0.9, N.y);
    lit += uWarm * under * uUnderlight * 0.55;

    gl_FragColor = vec4(lit, 1.0);
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

  // ── Fur ────────────────────────────────────────────────────────────────
  const FUR_LENGTH = 0.3;
  const sphere = new THREE.SphereGeometry(1, 96, 64);
  const furGeometry = track(new THREE.InstancedBufferGeometry());
  furGeometry.index = sphere.index;
  furGeometry.setAttribute("position", sphere.getAttribute("position"));
  // Sized for the densest setting; fewer layers reuse the front of the buffer.
  const MAX_SHELLS = 64;
  const shellLevels = new Float32Array(MAX_SHELLS);
  const shellAttribute = new THREE.InstancedBufferAttribute(shellLevels, 1);
  furGeometry.setAttribute("aShell", shellAttribute);
  furGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1 + FUR_LENGTH * 1.6);
  track(sphere);

  const furMaterial = track(
    new THREE.ShaderMaterial({
      vertexShader: FUR_VERT,
      fragmentShader: FUR_FRAG,
      uniforms: {
        uFurLength: { value: FUR_LENGTH },
        uDensity: { value: 54 },
        uShellStep: { value: 1 },
        uTime: { value: 0 },
        uVelocity: { value: new THREE.Vector3() },
        uRoot: { value: new THREE.Color("#d6c4aa") },
        uCoat: { value: new THREE.Color("#f3e7d2") },
        uTip: { value: new THREE.Color("#fff8ea") },
        uBlush: { value: new THREE.Color("#ff9fb6") },
        uWarm: { value: new THREE.Color("#ffb347") },
        uRim: { value: new THREE.Color("#a9b8ff") },
        uKeyDir: { value: new THREE.Vector3(-0.45, 0.7, 0.75) },
        uGlow: { value: 1 },
        uUnderlight: { value: 0 },
      },
    }),
  );
  const fur = new THREE.Mesh(furGeometry, furMaterial);
  body.add(fur);

  function setShells(count: number) {
    const shells = Math.max(4, Math.min(MAX_SHELLS, Math.round(count)));
    for (let i = 0; i < shells; i++) shellLevels[i] = i / (shells - 1);
    shellAttribute.needsUpdate = true;
    furGeometry.instanceCount = shells;
    furMaterial.uniforms.uShellStep!.value = 1 / (shells - 1);
  }
  setShells(options.shells);

  // ── Face ───────────────────────────────────────────────────────────────
  // Features sit just inside the fur tips so the coat frames them.
  const FACE_R = 1 + FUR_LENGTH * 0.74 * 0.62;
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
  antenna.position.set(0.1, 1 + FUR_LENGTH * 0.35, 0.06);
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
    furMaterial.uniforms.uTime!.value = time;
    (furMaterial.uniforms.uVelocity!.value as THREE.Vector3).copy(pose.velocity);
    furMaterial.uniforms.uGlow!.value = pose.glow;
    furMaterial.uniforms.uUnderlight!.value = pose.underlight;

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
