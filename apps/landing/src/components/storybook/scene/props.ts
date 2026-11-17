import * as THREE from "three";
import { TRUST_LEVELS, smoothstep } from "./timeline";

/**
 * One prop per chapter. Each is told how present it is (0..1) and where the
 * things it relates to are, and lays itself out from that — so the staging
 * lives in `timeline.ts` and these only know how to draw.
 */

type Track = <T extends { dispose(): void }>(item: T) => T;

// ── Chapter 1 — pages that drift, then fall into order ────────────────────

export interface Pages {
  group: THREE.Group;
  /** `order` 0 = scattered, 1 = stacked in a tidy grid. */
  update(time: number, weight: number, order: number, lumi: THREE.Vector3, radius: number): void;
}

const PAGE_COUNT = 9;

export function createPages(track: Track): Pages {
  const group = new THREE.Group();
  const geometry = track(new THREE.PlaneGeometry(1, 1.3));
  const pages: { mesh: THREE.Mesh; material: THREE.ShaderMaterial }[] = [];
  for (let i = 0; i < PAGE_COUNT; i++) {
    const material = track(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uSeed: { value: i * 1.37 + 0.2 },
          uOpacity: { value: 0 },
          uOrder: { value: 0 },
          uPaper: { value: new THREE.Color("#f7ecd6") },
          uInk: { value: new THREE.Color("#8a6a4a") },
          uGold: { value: new THREE.Color("#ffbf4d") },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uSeed, uOpacity, uOrder;
          uniform vec3 uPaper, uInk, uGold;
          varying vec2 vUv;
          float box(vec2 p, vec2 half, float r) {
            vec2 d = abs(p) - half + r;
            return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
          }
          void main() {
            vec2 p = (vUv - 0.5) * vec2(1.0, 1.3);
            float card = box(p, vec2(0.5, 0.65), 0.07);
            float alpha = smoothstep(0.012, -0.012, card);
            if (alpha < 0.01) discard;

            vec3 col = uPaper * (0.86 + 0.14 * vUv.y);
            // A heading and a few lines of text, different on every page.
            float head = step(box(p - vec2(-0.1, 0.42), vec2(0.26, 0.035), 0.03), 0.0);
            col = mix(col, uInk, head * 0.75);
            for (int i = 0; i < 5; i++) {
              float fi = float(i);
              float len = 0.2 + 0.18 * fract(sin(uSeed * 12.9 + fi * 7.3) * 43758.5);
              float line = step(box(p - vec2(-0.36 + len, 0.22 - fi * 0.14), vec2(len, 0.022), 0.02), 0.0);
              col = mix(col, uInk, line * 0.38);
            }
            // Once a page is in order it earns a gold seal.
            float seal = smoothstep(0.012, -0.012, length(p - vec2(0.28, -0.44)) - 0.09);
            col = mix(col, uGold * 1.6, seal * uOrder);
            // Gilded edge.
            float edge = smoothstep(-0.05, 0.0, card);
            col += uGold * edge * (0.2 + 0.5 * uOrder);
            gl_FragColor = vec4(col, alpha * uOpacity);
          }
        `,
      }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 5;
    group.add(mesh);
    pages.push({ mesh, material });
  }

  const scattered = new THREE.Vector3();
  const tidy = new THREE.Vector3();
  const scatteredRotation = new THREE.Euler();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();

  return {
    group,
    update(time, weight, order, lumi, radius) {
      group.visible = weight > 0.01;
      if (!group.visible) return;
      const size = radius * 0.62;
      for (let i = 0; i < PAGE_COUNT; i++) {
        const { mesh, material } = pages[i]!;
        // Each page settles a beat after the one before it.
        const settle = smoothstep((order - i * 0.045) / 0.55);

        const angle = i * 2.399 + time * 0.22;
        const reach = radius * (2.3 + 0.9 * Math.sin(i * 1.7));
        scattered.set(
          lumi.x + Math.cos(angle) * reach,
          lumi.y + Math.sin(angle) * reach * 0.72 + Math.sin(time * 0.8 + i) * radius * 0.15,
          lumi.z + Math.sin(angle * 1.3 + i) * radius * 0.9,
        );
        scatteredRotation.set(time * 0.5 + i * 1.1, time * 0.35 + i * 2.3, time * 0.2 + i * 0.7);

        const column = i % 3;
        const row = Math.floor(i / 3);
        tidy.set(
          lumi.x - radius * 3.55 + column * size * 1.18,
          lumi.y + radius * 1.05 - row * size * 1.5,
          lumi.z - radius * 0.2,
        );

        mesh.position.lerpVectors(scattered, tidy, settle);
        qa.setFromEuler(scatteredRotation);
        qb.set(0, 0, 0, 1);
        mesh.quaternion.slerpQuaternions(qa, qb, settle);
        mesh.scale.setScalar(size * (0.82 + 0.18 * settle));
        material.uniforms.uOpacity!.value = weight * (0.55 + 0.45 * settle);
        material.uniforms.uOrder!.value = settle;
      }
    },
  };
}

// ── Chapter 2 — a staircase of stars, one per autonomy level ──────────────

export interface Stairs {
  group: THREE.Group;
  update(
    time: number,
    weight: number,
    level: number,
    place: (index: number, target: THREE.Vector3) => number,
  ): void;
}

function starShape(): THREE.Shape {
  const shape = new THREE.Shape();
  const points = 5;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 1 : 0.5;
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

export function createStairs(glowMap: THREE.Texture, track: Track): Stairs {
  const group = new THREE.Group();
  const geometry = track(
    new THREE.ExtrudeGeometry(starShape(), {
      depth: 0.3,
      bevelEnabled: true,
      bevelThickness: 0.1,
      bevelSize: 0.09,
      bevelSegments: 3,
      curveSegments: 4,
    }),
  );
  geometry.center();

  const earned = new THREE.Color("#ffb52e");
  const waiting = new THREE.Color("#5b4fa8");
  const steps: {
    mesh: THREE.Mesh;
    material: THREE.MeshStandardMaterial;
    glow: THREE.Sprite;
    glowMaterial: THREE.SpriteMaterial;
    lit: number;
  }[] = [];
  for (let i = 0; i < TRUST_LEVELS; i++) {
    const material = track(
      new THREE.MeshStandardMaterial({
        color: "#ffd27a",
        roughness: 0.35,
        metalness: 0.75,
        emissive: waiting.clone(),
        emissiveIntensity: 0.4,
        transparent: true,
      }),
    );
    const mesh = new THREE.Mesh(geometry, material);
    const glowMaterial = track(
      new THREE.SpriteMaterial({
        map: glowMap,
        color: "#ffc45a",
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    const glow = new THREE.Sprite(glowMaterial);
    glow.renderOrder = 4;
    group.add(glow, mesh);
    steps.push({ mesh, material, glow, glowMaterial, lit: 0 });
  }

  const at = new THREE.Vector3();
  return {
    group,
    update(time, weight, level, place) {
      group.visible = weight > 0.01;
      if (!group.visible) return;
      for (let i = 0; i < TRUST_LEVELS; i++) {
        const step = steps[i]!;
        const size = place(i, at);
        // Every level up to the current one has been earned and stays lit.
        const target = i <= level ? 1 : 0;
        step.lit += (target - step.lit) * 0.12;
        const current = i === level ? 1 : 0;
        step.mesh.position.copy(at);
        step.mesh.position.y += Math.sin(time * 1.1 + i * 0.9) * size * 0.08;
        step.mesh.rotation.set(-0.25, Math.sin(time * 0.6 + i) * 0.35, 0);
        step.mesh.scale.setScalar(size * weight * (1 + 0.12 * current));
        step.material.emissive.copy(waiting).lerp(earned, step.lit);
        step.material.emissiveIntensity = 0.35 + 1.1 * step.lit;
        step.material.opacity = weight;
        step.glow.position.copy(step.mesh.position);
        step.glow.position.z -= size * 0.4;
        step.glow.scale.setScalar(size * (2.2 + 2.2 * step.lit));
        step.glowMaterial.opacity = weight * (0.12 + 0.5 * step.lit);
      }
    },
  };
}

// ── Chapter 4 — visiting agents, orbiting inside a ring of rules ──────────

export interface Wisps {
  group: THREE.Group;
  /** World position of wisp `index`, for trailing sparkles. */
  position(index: number): THREE.Vector3;
  readonly colors: readonly THREE.Color[];
  update(time: number, weight: number, lumi: THREE.Vector3, radius: number): void;
}

export function createWisps(glowMap: THREE.Texture, track: Track): Wisps {
  const group = new THREE.Group();
  const colors = [new THREE.Color("#5fe6ff"), new THREE.Color("#b58bff"), new THREE.Color("#ff9ed0")];
  const core = track(new THREE.SphereGeometry(1, 16, 12));
  const wisps = colors.map((color) => {
    const material = track(new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.4), transparent: true }));
    const mesh = new THREE.Mesh(core, material);
    const glowMaterial = track(
      new THREE.SpriteMaterial({
        map: glowMap,
        color,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    const glow = new THREE.Sprite(glowMaterial);
    group.add(mesh, glow);
    return { mesh, material, glow, glowMaterial };
  });

  const ringMaterial = track(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color("#ffd27a").multiplyScalar(1.5),
      transparent: true,
      depthWrite: false,
    }),
  );
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(1, 0.006, 6, 120)), ringMaterial);
  const ringOuter = new THREE.Mesh(track(new THREE.TorusGeometry(1, 0.004, 6, 120)), ringMaterial);
  group.add(ring, ringOuter);

  return {
    group,
    colors,
    position: (index) => wisps[index]!.mesh.position,
    update(time, weight, lumi, radius) {
      group.visible = weight > 0.01;
      if (!group.visible) return;
      const orbit = radius * 2.25;
      for (let i = 0; i < wisps.length; i++) {
        const wisp = wisps[i]!;
        const a = time * (0.55 + i * 0.13) + (i * Math.PI * 2) / 3;
        const tilt = 0.35 + i * 0.5;
        wisp.mesh.position.set(
          lumi.x + Math.cos(a) * orbit,
          lumi.y + Math.sin(a) * orbit * Math.cos(tilt) * 0.55,
          lumi.z + Math.sin(a) * orbit * Math.sin(tilt + 0.6),
        );
        wisp.mesh.scale.setScalar(radius * 0.11 * weight);
        wisp.material.opacity = weight;
        wisp.glow.position.copy(wisp.mesh.position);
        wisp.glow.scale.setScalar(radius * (0.9 + 0.2 * Math.sin(time * 3 + i)) * weight);
        wisp.glowMaterial.opacity = 0.85 * weight;
      }
      ring.position.copy(lumi);
      ring.scale.setScalar(orbit * 1.22 * (0.7 + 0.3 * weight));
      ring.rotation.set(1.2, time * 0.12, 0.2);
      ringOuter.position.copy(lumi);
      ringOuter.scale.setScalar(orbit * 1.42 * (0.7 + 0.3 * weight));
      ringOuter.rotation.set(1.05, -time * 0.09, -0.35);
      ringMaterial.opacity = 0.55 * weight;
    },
  };
}

// ── Chapter 5 — a trail of crumbs back to where a change came from ────────

export interface Trail {
  group: THREE.Group;
  update(time: number, weight: number, progress: number, from: THREE.Vector3, to: THREE.Vector3, size: number): void;
}

const BEADS = 5;
const DOTS = 44;

export function createTrail(glowMap: THREE.Texture, track: Track): Trail {
  const group = new THREE.Group();
  const beadGeometry = track(new THREE.SphereGeometry(1, 18, 14));
  const lit = new THREE.Color("#ffc24a").multiplyScalar(2.2);
  const dim = new THREE.Color("#4b4190");
  const beads = Array.from({ length: BEADS }, () => {
    const material = track(new THREE.MeshBasicMaterial({ color: dim.clone(), transparent: true }));
    const mesh = new THREE.Mesh(beadGeometry, material);
    const glowMaterial = track(
      new THREE.SpriteMaterial({
        map: glowMap,
        color: "#ffc45a",
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    const glow = new THREE.Sprite(glowMaterial);
    group.add(mesh, glow);
    return { mesh, material, glow, glowMaterial, lit: 0 };
  });

  const dotPositions = new Float32Array(DOTS * 3);
  const dotGeometry = track(new THREE.BufferGeometry());
  const dotAttribute = new THREE.BufferAttribute(dotPositions, 3).setUsage(THREE.DynamicDrawUsage);
  dotGeometry.setAttribute("position", dotAttribute);
  const dotMaterial = track(
    new THREE.PointsMaterial({
      color: new THREE.Color("#ffd58a").multiplyScalar(1.6),
      size: 0.05,
      map: glowMap,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }),
  );
  const dots = new THREE.Points(dotGeometry, dotMaterial);
  dots.frustumCulled = false;
  group.add(dots);

  const curve = new THREE.QuadraticBezierCurve3();
  const point = new THREE.Vector3();
  return {
    group,
    update(time, weight, progress, from, to, size) {
      group.visible = weight > 0.01;
      if (!group.visible) return;
      curve.v0.copy(from);
      curve.v2.copy(to);
      // Bow the path so it wanders like a footpath rather than a ruler line.
      curve.v1.set(from.x + (to.x - from.x) * 0.72, from.y + (to.y - from.y) * 0.08, (from.z + to.z) / 2);

      for (let i = 0; i < DOTS; i++) {
        curve.getPoint(i / (DOTS - 1), point);
        dotPositions[i * 3] = point.x;
        dotPositions[i * 3 + 1] = point.y + Math.sin(time * 1.4 + i * 0.6) * size * 0.05;
        dotPositions[i * 3 + 2] = point.z;
      }
      dotAttribute.needsUpdate = true;
      dotMaterial.size = size * 0.22;
      dotMaterial.opacity = 0.75 * weight;

      for (let i = 0; i < BEADS; i++) {
        const bead = beads[i]!;
        const t = (i + 0.35) / BEADS;
        curve.getPoint(t, point);
        // Crumbs light up one after another as the reader moves through.
        const target = progress * 1.25 > t ? 1 : 0;
        bead.lit += (target - bead.lit) * 0.1;
        bead.mesh.position.copy(point);
        bead.mesh.scale.setScalar(size * (0.3 + 0.12 * bead.lit) * weight);
        bead.material.color.copy(dim).lerp(lit, bead.lit);
        bead.material.opacity = weight;
        bead.glow.position.copy(point);
        bead.glow.scale.setScalar(size * (1.2 + 1.8 * bead.lit) * weight);
        bead.glowMaterial.opacity = (0.1 + 0.6 * bead.lit) * weight;
      }
    },
  };
}
