import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { createLumi } from "./lumi";
import { createPages, createStairs, createTrail, createWisps } from "./props";
import { createFlareTexture, createGlowTexture } from "./textures";
import {
  CHAPTERS,
  LAMP_OFFSET,
  LAST_CHAPTER,
  TRUST_CHAPTER,
  TRUST_LEVELS,
  altitude as altitudeAt,
  lerp,
  lumiAnchor,
  lumiOnStep,
  presence,
  smoothstep,
  trustStep,
  within,
  type Layout,
} from "./timeline";
import { createHills, createLamp, createMoon, createSky, createSparkles, createStars, hillHeight } from "./world";

export interface StoryOptions {
  layout: Layout;
  /** No intro, no idle motion, no particles: the scene only changes when the reader scrolls. */
  reducedMotion: boolean;
  /** Phones and other constrained devices start on the lighter settings. */
  lowPower: boolean;
  /**
   * Called once if the device cannot keep the scene moving even on the
   * lightest settings. The caller should drop the scene for the static
   * fallback; a story at a few frames a second reads worse than none.
   */
  onGiveUp?: () => void;
}

export interface StoryScene {
  /** Chapter coordinate — see `timeline.ts`. */
  setChapter(c: number): void;
  /** Autonomy level picked in the trust chapter, 0..4. */
  setLevel(level: number): void;
  /** Pointer in screen space, -1..1 with y up. */
  setPointer(x: number, y: number, active: boolean): void;
  /** A tap at a screen position. True if it landed on Lumi or the lamp. */
  poke(x: number, y: number): boolean;
  setLayout(layout: Layout): void;
  resize(width: number, height: number): void;
  /** Draw one frame. `now` is a `requestAnimationFrame` timestamp. */
  render(now: number): void;
  dispose(): void;
  /** Release the WebGL context now rather than at GC. Only once the canvas is gone for good. */
  loseContext(): void;
}

const FOV = 35;
const CAMERA_Z = 12;
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
/** Lumi and the lamp sit a little in front of the z=0 hill so nothing clips into it. */
const LAMP_Z = 1.1;
const LUMI_Z = 1.6;
const INTRO_SECONDS = 2.6;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

/** Per-chapter gaze when there is no pointer to follow: mostly toward the copy. */
const GAZE: Record<Layout, readonly [number, number][]> = {
  desktop: [[-0.3, 0.05], [-0.55, -0.1], [-0.35, 0.1], [-0.6, -0.55], [-0.4, 0], [-0.5, -0.3], [0, 0.15]],
  mobile: [[0, 0.3], [0, -0.45], [0, -0.3], [-0.4, -0.5], [0, -0.45], [-0.3, -0.5], [0, 0.3]],
};

export function createStoryScene(canvas: HTMLCanvasElement, options: StoryOptions): StoryScene {
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  let layout = options.layout;
  const reduced = options.reducedMotion;

  // ── Renderer ───────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // the composer's multisampled target does this
    powerPreference: "high-performance",
    alpha: false,
    // A software rasteriser (SwiftShader, llvmpipe) draws this scene at a
    // frame or two a second. Refuse it, so the page falls back to the static
    // stage instead of stalling the main thread.
    failIfMajorPerformanceCaveat: true,
  });
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;

  // Quality ladder. Each rung trades a little fidelity for a lot of fill-rate;
  // `render` steps down it when frames run long.
  const QUALITY = [
    { pixelRatio: 1.75, shells: 48, bloom: true, samples: 4 },
    { pixelRatio: 1.35, shells: 40, bloom: true, samples: 4 },
    { pixelRatio: 1.15, shells: 30, bloom: true, samples: 0 },
    { pixelRatio: 1, shells: 22, bloom: true, samples: 0 },
    { pixelRatio: 0.85, shells: 18, bloom: false, samples: 0 },
  ] as const;
  let rung = options.lowPower ? 2 : 0;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = track(pmrem.fromScene(room, 0.04));
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.55;
  room.dispose();
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 120);
  camera.position.set(0, 0, CAMERA_Z);

  // Half-extent of the screen, in world units, at depth z.
  let aspect = 1;
  const halfHeightAt = (z: number) => TAN * (CAMERA_Z - z);
  const halfWidthAt = (z: number) => halfHeightAt(z) * aspect;
  /** Screen anchor (-1..1) to a world position at depth z, relative to the camera. */
  const place = (x: number, y: number, z: number, target: THREE.Vector3) =>
    target.set(camera.position.x + x * halfWidthAt(z), camera.position.y + y * halfHeightAt(z), z);

  // ── Stage ──────────────────────────────────────────────────────────────
  const glowMap = track(createGlowTexture());
  const flareMap = track(createFlareTexture());

  const sky = createSky(track);
  scene.add(sky.mesh);

  /** Stars and moon are far enough away that the climb barely moves them. */
  const heavens = new THREE.Group();
  scene.add(heavens);
  const stars = createStars(options.lowPower ? 700 : 1500, track);
  stars.points.renderOrder = -60;
  heavens.add(stars.points);
  const moon = createMoon(track);
  moon.renderOrder = -55;
  heavens.add(moon);
  const MOON_Z = -14;

  // A shooting star: a streak that crosses the sky every so often.
  const streakMaterial = track(
    new THREE.SpriteMaterial({
      map: flareMap,
      color: new THREE.Color("#dfe6ff").multiplyScalar(1.8),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    }),
  );
  const streak = new THREE.Sprite(streakMaterial);
  streak.renderOrder = -58;
  heavens.add(streak);
  let streakStart = 4;
  let streakFrom = new THREE.Vector2(-0.3, 0.8);

  const hills = createHills(track);
  for (const hill of hills) scene.add(hill.mesh);
  const frontHill = hills[hills.length - 1]!;

  const lamp = createLamp(glowMap, track);
  scene.add(lamp.group);

  const lumi = createLumi({ shells: QUALITY[rung]!.shells });
  scene.add(lumi.group);

  const pages = createPages(track);
  const stairs = createStairs(glowMap, track);
  const wisps = createWisps(glowMap, track);
  const trail = createTrail(glowMap, track);
  scene.add(pages.group, stairs.group, wisps.group, trail.group);

  const sparkles = createSparkles(options.lowPower ? 320 : 640, track);
  scene.add(sparkles.points);

  // A little fill so the gold and the stars read; the fur lights itself.
  const key = new THREE.DirectionalLight("#ffe9c4", 1.5);
  key.position.set(-3, 5, 6);
  const moonlight = new THREE.DirectionalLight("#8f9dff", 1.1);
  moonlight.position.set(5, 3, -2);
  scene.add(key, moonlight, new THREE.AmbientLight("#3a2f78", 0.6));

  // ── Post ───────────────────────────────────────────────────────────────
  let width = 1;
  let height = 1;
  let composer: EffectComposer | null = null;

  /** The composer owns its render targets but not the passes added to it. */
  function disposeComposer() {
    if (!composer) return;
    for (const pass of composer.passes) pass.dispose();
    composer.dispose();
    composer = null;
  }

  /**
   * Build the post-processing chain for the current quality rung. Only a rung
   * change needs this; a resize just resizes what is already there.
   */
  function buildComposer() {
    const quality = QUALITY[rung]!;
    disposeComposer();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, quality.pixelRatio);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    // The composer takes this target as its own and disposes it with itself.
    const target = new THREE.WebGLRenderTarget(width * pixelRatio, height * pixelRatio, {
      type: THREE.HalfFloatType,
      samples: quality.samples,
    });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    composer.addPass(new RenderPass(scene, camera));
    if (quality.bloom) {
      // Threshold above 1: only things brighter than paper-white glow, so the
      // lamp, the stars and the antenna bloom and Lumi's coat does not.
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.5, 0.75, 1.15));
    }
    composer.addPass(new OutputPass());
    lumi.setShells(quality.shells);
    builtPixelRatio = pixelRatio;
  }
  let builtPixelRatio = 0;

  function resizeComposer() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, QUALITY[rung]!.pixelRatio);
    // Moving to a screen with another pixel ratio changes the target's size in
    // a way setSize alone would not pick up.
    if (!composer || pixelRatio !== builtPixelRatio) {
      buildComposer();
      return;
    }
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
  }

  function fitStage() {
    for (const hill of hills) {
      const half = halfHeightAt(hill.z);
      hill.fit(halfWidthAt(hill.z), -half, RISE());
    }
  }
  /** How far the camera climbs to leave the ground behind. */
  const RISE = () => halfHeightAt(0) * 2.7;

  // ── State ──────────────────────────────────────────────────────────────
  let chapter = 0;
  let level = 3;
  const pointer = new THREE.Vector2();
  let pointerActive = false;

  let clock = 0;
  let last = -1;
  /** Vertical camera lean toward the pointer; kept apart from the climb. */
  let leanY = 0;
  let introStart = -1;
  let hopStart = -10;
  let hopHeight = 1;
  let squintUntil = 0;

  const lumiPosition = new THREE.Vector3();
  const lumiVelocity = new THREE.Vector3();
  const furVelocity = new THREE.Vector3();
  let lumiRadius = 1;
  let hasPosition = false;

  const pose = {
    velocity: furVelocity,
    look: new THREE.Vector2(),
    glow: 1,
    underlight: 0,
    stretch: 1,
    squint: false,
  };

  const scratch = new THREE.Vector3();
  const scratch2 = new THREE.Vector3();
  const scratch3 = new THREE.Vector3();
  const target = new THREE.Vector3();
  const spout = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const glowScreen = new THREE.Vector2();
  const gold = new THREE.Color("#ffc65a");
  const pearl = new THREE.Color("#fff3da");
  const rose = new THREE.Color("#ff9ec4");
  const palette = [gold, gold, pearl, rose];
  let emitDebt = 0;

  function burst(at: THREE.Vector3, count: number, speed: number, size: number) {
    if (reduced) return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(Math.random() * 2 - 1);
      const v = speed * (0.35 + Math.random() * 0.65);
      scratch.set(Math.sin(b) * Math.cos(a) * v, Math.cos(b) * v, Math.sin(b) * Math.sin(a) * v * 0.6);
      sparkles.emit(
        at,
        scratch,
        0.8 + Math.random() * 1.1,
        size * (0.5 + Math.random()),
        palette[(Math.random() * palette.length) | 0]!,
      );
    }
  }

  function hop(heightScale: number) {
    hopStart = clock;
    hopHeight = heightScale;
  }

  // Frame-time watchdog for the quality ladder.
  //
  // Slow frames alone do not mean a slow GPU: a phone in low-power mode is
  // locked to 30fps however light the scene is, and lowering quality there
  // buys nothing. So a step down is a *probe* — if two rungs make no
  // difference to frame time, the display is the limit, and the scene goes
  // back to the quality it started at and stops judging.
  const WINDOW = 60;
  const WARMUP = 24;
  /** Longer than this is a pause (tab switch, scrolled away), not a slow frame. */
  const PAUSE = 2;
  const samples = new Float32Array(WINDOW);
  let sampled = -WARMUP;
  let probe: { from: number; baseline: number; steps: number } | null = null;
  let settled = false;

  // A device far below budget would take minutes to walk the ladder one probe
  // at a time — and a window of slow frames is exactly when the reader is
  // looking at a stalled page. So a run of very slow frames skips straight to
  // the bottom rung, and a second run there gives the scene up.
  const STALLED = 1 / 15;
  const STALL_RUN = 12;
  let stallRun = 0;
  let gaveUp = false;

  function rescue(frame: number) {
    if (gaveUp || frame <= 0 || frame > PAUSE) return;
    if (frame < STALLED) {
      stallRun = 0;
      return;
    }
    if (++stallRun < STALL_RUN) return;
    stallRun = 0;
    if (rung < QUALITY.length - 1) {
      rung = QUALITY.length - 1;
      probe = null;
      settled = true;
      buildComposer();
    } else {
      gaveUp = true;
      options.onGiveUp?.();
    }
  }

  function judge(frame: number) {
    if (settled || frame <= 0 || frame > PAUSE) return;
    if (sampled < 0) {
      sampled++; // let a rebuilt chain warm up before measuring it
      return;
    }
    samples[sampled++] = frame;
    if (sampled < WINDOW) return;
    sampled = -WARMUP;
    const median = Array.from(samples).sort((a, b) => a - b)[WINDOW >> 1]!;

    if (probe) {
      if (median < probe.baseline * 0.85) {
        probe = null; // the step helped; keep it and keep watching
      } else if (probe.steps < 2 && rung < QUALITY.length - 1) {
        probe.steps++;
        rung++;
        buildComposer();
        return;
      } else {
        rung = probe.from; // capped by the display, not by us
        probe = null;
        settled = true;
        buildComposer();
        return;
      }
    }
    if (median > 1 / 45 && rung < QUALITY.length - 1) {
      probe = { from: rung, baseline: median, steps: 1 };
      rung++;
      buildComposer();
    }
  }

  function render(now: number) {
    const seconds = now / 1000;
    const rawDt = last < 0 ? 0 : Math.max(0, seconds - last);
    last = seconds;
    // Timed beats (the intro, hops, blinks) follow the wall clock, so a slow
    // device shows them at their real length rather than in slow motion; only
    // a pause is cut short. Damping and springs step at most 0.1 s, which they
    // stay stable at — at 0.05 s they lagged far behind below 20 fps.
    const tick = rawDt === 0 ? 1 / 60 : Math.min(0.25, rawDt);
    const dt = Math.min(0.1, tick);
    // Under reduced motion the clock is parked, so idle animation never runs.
    if (!reduced) clock += tick;
    // A parked clock must sit before Lumi's first blink, or the eyes stay shut.
    const time = reduced ? 1 : clock;
    if (introStart < 0) introStart = clock;

    const c = chapter;
    const altitude = altitudeAt(c);
    const grounded = 1 - altitude;

    // ── Camera: climbs off the hill, and leans a touch toward the pointer ──
    const lean = pointerActive && !reduced ? 1 : 0;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, pointer.x * 0.22 * lean, 3, dt);
    leanY = reduced ? 0 : THREE.MathUtils.damp(leanY, pointer.y * 0.12 * lean, 3, dt);
    camera.position.y = altitude * RISE() + leanY;
    camera.lookAt(camera.position.x * 0.4, camera.position.y, 0);

    // ── Heavens ────────────────────────────────────────────────────────────
    heavens.position.set(camera.position.x * 0.9, camera.position.y * 0.94, 0);
    stars.update(time, renderer.getPixelRatio() * Math.max(0.8, height / 900), 0.55 + 0.45 * altitude);
    const moonHalf = halfHeightAt(MOON_Z);
    // On a phone Lumi's high poses sit near x 0.4-0.5; keep the moon clear of them.
    const moonX = layout === "desktop" ? 0.63 : 0.74;
    const moonY = layout === "desktop" ? 0.72 : 0.8;
    moon.position.set(moonX * moonHalf * aspect, moonY * moonHalf + camera.position.y * 0.02, MOON_Z);
    moon.scale.setScalar(moonHalf * (layout === "desktop" ? 0.46 : 0.34));

    if (!reduced) {
      const t = (time - streakStart) / 1.1;
      if (t > 1) {
        streakStart = time + 5 + Math.random() * 7;
        streakFrom = new THREE.Vector2(-0.7 + Math.random() * 1.2, 0.55 + Math.random() * 0.4);
        streakMaterial.opacity = 0;
      } else if (t >= 0) {
        const far = halfHeightAt(-30);
        streak.position.set(
          (streakFrom.x + t * 0.5) * far * aspect,
          (streakFrom.y - t * 0.28) * far,
          -30,
        );
        streak.scale.set(far * 0.5, far * 0.05, 1);
        streakMaterial.rotation = -0.5;
        streakMaterial.opacity = Math.sin(t * Math.PI) * 0.9;
      }
    }

    // ── Lumi ───────────────────────────────────────────────────────────────
    const anchor = lumiAnchor(layout, c);
    const onStairs = presence(c, TRUST_CHAPTER, 0.5);
    const step = lumiOnStep(layout, level);
    const ax = lerp(anchor.x, step.x, onStairs);
    const ay = lerp(anchor.y, step.y, onStairs);
    const as = lerp(anchor.s, step.s, onStairs);
    lumiRadius = as * halfHeightAt(LUMI_Z);
    place(ax, ay, LUMI_Z, target);

    // ── Lamp, on the front hill under the opening and closing poses ───────
    const lampHome = lumiAnchor(layout, c < LAST_CHAPTER / 2 ? 0 : LAST_CHAPTER);
    const lampScale = lampHome.s * halfHeightAt(LAMP_Z) * 0.8;
    const lampX = (lampHome.x + LAMP_OFFSET[layout]) * halfWidthAt(LAMP_Z);
    lamp.group.position.set(lampX, hillHeight(frontHill.shape, lampX) - lampScale * 0.04, LAMP_Z);
    lamp.group.scale.setScalar(lampScale);
    lamp.group.visible = grounded > 0.02;
    lamp.group.updateMatrixWorld();
    lamp.spoutWorld(spout);

    // The opening: Lumi squeezes out of the spout and springs up to size.
    const intro = reduced ? 1 : Math.min(1, Math.max(0, (clock - introStart - 0.5) / INTRO_SECONDS));
    const emerged = easeOutCubic(intro);
    if (intro < 1 && c < 0.5) {
      const rise = easeOutBack(Math.min(1, intro * 1.15));
      scratch.lerpVectors(spout, target, rise);
      // Curl out of the spout rather than travelling in a straight line.
      scratch.x -= Math.sin(intro * Math.PI) * lumiRadius * 0.9;
      target.copy(scratch);
    }

    if (!hasPosition || reduced) {
      lumiPosition.copy(target);
      lumiVelocity.set(0, 0, 0);
      hasPosition = true;
    } else {
      const previous = scratch2.copy(lumiPosition);
      const follow = intro < 1 ? 14 : 5.5;
      lumiPosition.x = THREE.MathUtils.damp(lumiPosition.x, target.x, follow, dt);
      lumiPosition.y = THREE.MathUtils.damp(lumiPosition.y, target.y, follow, dt);
      lumiPosition.z = target.z;
      if (dt > 0) lumiVelocity.subVectors(lumiPosition, previous).divideScalar(dt);
    }

    // Hop: an arc with a stretch on the way up and a squash on landing.
    const hopT = reduced ? 1 : (clock - hopStart) / 0.62;
    let hopLift = 0;
    let stretch = 1;
    if (hopT >= 0 && hopT < 1) {
      hopLift = Math.sin(hopT * Math.PI) * lumiRadius * 0.95 * hopHeight;
      stretch = 1 + Math.sin(hopT * Math.PI * 2) * 0.16;
    } else if (hopT >= 1 && hopT < 1.5) {
      stretch = 1 - Math.sin((hopT - 1) * 2 * Math.PI) * 0.1 * (1.5 - hopT) * 2;
    }
    const bob = reduced ? 0 : Math.sin(time * 1.25) * lumiRadius * 0.07;
    // Moving fast stretches Lumi along the direction of travel.
    const speed = lumiVelocity.length() / Math.max(lumiRadius, 1e-3);
    stretch *= 1 + Math.min(0.22, Math.abs(lumiVelocity.y / Math.max(lumiRadius, 1e-3)) * 0.035);

    lumi.group.position.set(lumiPosition.x, lumiPosition.y + hopLift + bob, lumiPosition.z);
    lumi.group.scale.setScalar(lumiRadius * lerp(0.08, 1, emerged));
    lumi.group.rotation.z = intro < 1 ? (1 - emerged) * 2.4 : 0;

    // Fur trails behind the motion (velocity in body radii per second).
    scratch.copy(lumiVelocity).divideScalar(Math.max(lumiRadius, 1e-3)).multiplyScalar(0.085);
    scratch.y += hopT >= 0 && hopT < 1 ? Math.cos(hopT * Math.PI) * 0.5 * hopHeight : 0;
    if (scratch.length() > 0.9) scratch.setLength(0.9);
    furVelocity.lerp(scratch, 1 - Math.exp(-10 * dt));

    // Gaze: the pointer if there is one, otherwise the chapter's default.
    const nearest = Math.min(LAST_CHAPTER, Math.max(0, Math.round(c)));
    const gaze = GAZE[layout][nearest]!;
    if (pointerActive && !reduced) {
      pose.look.set(
        THREE.MathUtils.clamp((pointer.x - ax) * 1.3, -1, 1),
        THREE.MathUtils.clamp((pointer.y - ay) * 1.3, -1, 1),
      );
    } else {
      pose.look.set(gaze[0], gaze[1]);
    }
    pose.stretch = stretch;
    pose.squint = intro < 0.85 || clock < squintUntil || (hopT >= 0 && hopT < 1);
    pose.glow = 0.85 + 0.15 * Math.sin(time * 2.1);
    pose.underlight = grounded * (intro < 1 ? 1 : 0.75);
    lumi.update(dt, time, pose);

    // ── Ground glow ────────────────────────────────────────────────────────
    const lampGlow = grounded * (0.75 + 0.25 * Math.sin(time * 2.6));
    lamp.setGlow(lampGlow);
    for (const hill of hills) hill.setGlow(lampX, lampGlow * (hill === frontHill ? 1 : 0.35));
    // The castle keeps out from behind the copy: centre-stage for the opening,
    // off to the side for the ending, when Lumi takes the centre.
    const castleX = layout === "desktop" ? (c < LAST_CHAPTER / 2 ? 0.02 : -0.62) : 0.68;
    for (const hill of hills) hill.setCastle(castleX);
    scratch.copy(spout).project(camera);
    glowScreen.set(scratch.x, scratch.y);
    sky.update(time, altitude, aspect, glowScreen, lampGlow);

    // ── Chapter props ──────────────────────────────────────────────────────
    const intentIndex = CHAPTERS.indexOf("intent");
    pages.update(
      time,
      presence(c, intentIndex, 0.55),
      smoothstep((within(c, intentIndex) - 0.2) / 0.45),
      lumi.group.position,
      lumiRadius,
    );

    stairs.update(time, onStairs, level, (index, out) => {
      const s = trustStep(layout, index);
      place(s.x, s.y, LUMI_Z - 0.4, out);
      return s.s * halfHeightAt(LUMI_Z - 0.4);
    });

    const mcpIndex = CHAPTERS.indexOf("mcp");
    const mcpWeight = presence(c, mcpIndex, 0.5);
    wisps.update(time, mcpWeight, lumi.group.position, lumiRadius);

    const provenanceIndex = CHAPTERS.indexOf("provenance");
    const trailWeight = presence(c, provenanceIndex, 0.5);
    if (trailWeight > 0.01) {
      const from = layout === "desktop" ? place(0.08, -0.62, LUMI_Z - 0.3, scratch3) : place(-0.7, 0.36, LUMI_Z - 0.3, scratch3);
      scratch.copy(lumi.group.position);
      scratch.y -= lumiRadius * 1.5;
      trail.update(time, trailWeight, within(c, provenanceIndex), from, scratch, lumiRadius);
    } else {
      trail.group.visible = false;
    }

    // ── Sparkles ───────────────────────────────────────────────────────────
    if (!reduced) {
      lumi.tipWorld(tip);
      emitDebt += dt;
      const unit = lumiRadius;
      while (emitDebt > 1 / 60) {
        emitDebt -= 1 / 60;
        // The lamp breathes a slow plume of gold.
        if (grounded > 0.3 && Math.random() < 0.42 * grounded) {
          scratch.set((Math.random() - 0.6) * 0.5, 0.5 + Math.random() * 0.9, (Math.random() - 0.5) * 0.3).multiplyScalar(unit);
          scratch2.copy(spout).add(scratch3.set((Math.random() - 0.5) * 0.12, 0, 0).multiplyScalar(unit));
          sparkles.emit(scratch2, scratch, 1.4 + Math.random() * 1.6, unit * (0.1 + Math.random() * 0.16), palette[(Math.random() * 3) | 0]!);
        }
        // Dust shaken from the antenna, more of it the faster Lumi moves.
        if (emerged > 0.5 && Math.random() < 0.16 + Math.min(0.7, speed * 0.12)) {
          scratch.set((Math.random() - 0.5) * 0.5, -0.1 + Math.random() * 0.4, (Math.random() - 0.5) * 0.4).multiplyScalar(unit);
          scratch.addScaledVector(lumiVelocity, -0.12);
          sparkles.emit(tip, scratch, 0.7 + Math.random() * 0.9, unit * (0.07 + Math.random() * 0.1), palette[(Math.random() * palette.length) | 0]!);
        }
        // Visiting agents leave a thread of their own colour.
        if (mcpWeight > 0.4) {
          for (let i = 0; i < wisps.colors.length; i++) {
            if (Math.random() < 0.45) {
              scratch.set((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, 0).multiplyScalar(unit);
              sparkles.emit(wisps.position(i), scratch, 0.6 + Math.random() * 0.5, unit * 0.09, wisps.colors[i]!);
            }
          }
        }
      }
      // The pop as Lumi clears the spout.
      if (intro > 0.08 && intro < 0.12 && c < 0.5) burst(spout, 6, lumiRadius * 2.4, lumiRadius * 0.2);
      const pixelsPerUnit = (height * renderer.getPixelRatio()) / (2 * TAN);
      sparkles.update(dt, time, pixelsPerUnit);
    }

    if (composer) composer.render(dt);
    else renderer.render(scene, camera);

    if (!reduced && clock > 1.5) {
      judge(rawDt);
      rescue(rawDt);
    }
  }

  return {
    setChapter(c) {
      chapter = Math.min(LAST_CHAPTER, Math.max(0, c));
    },
    setLevel(next) {
      const clamped = Math.min(TRUST_LEVELS - 1, Math.max(0, Math.round(next)));
      if (clamped === level) return;
      hop(0.9 + Math.abs(clamped - level) * 0.25);
      level = clamped;
    },
    setPointer(x, y, active) {
      pointer.set(x, y);
      pointerActive = active;
    },
    poke(x, y) {
      if (reduced) return false;
      // Lumi: a happy hop and a puff of sparks.
      scratch.copy(lumi.group.position).project(camera);
      const dx = (x - scratch.x) * aspect;
      const dy = y - scratch.y;
      const reach = (lumiRadius / halfHeightAt(LUMI_Z)) * 1.35;
      if (dx * dx + dy * dy < reach * reach) {
        hop(1.1);
        squintUntil = clock + 1.1;
        burst(lumi.tipWorld(tip), 26, lumiRadius * 2.6, lumiRadius * 0.2);
        return true;
      }
      // The lamp: rubbing it shakes loose a fountain of gold.
      if (lamp.group.visible) {
        scratch.copy(lamp.group.position).project(camera);
        const lx = (x - scratch.x) * aspect;
        const ly = y - scratch.y - 0.08;
        const lampReach = (lamp.group.scale.x / halfHeightAt(LAMP_Z)) * 1.5;
        if (lx * lx + ly * ly < lampReach * lampReach) {
          burst(spout, 46, lumiRadius * 3.4, lumiRadius * 0.24);
          hop(0.7);
          return true;
        }
      }
      return false;
    },
    setLayout(next) {
      layout = next;
    },
    resize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      aspect = width / height;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      resizeComposer();
      fitStage();
    },
    render,
    dispose() {
      disposeComposer();
      lumi.dispose();
      for (const item of disposables) item.dispose();
      renderer.dispose();
    },
    loseContext() {
      renderer.forceContextLoss();
    },
  };
}
