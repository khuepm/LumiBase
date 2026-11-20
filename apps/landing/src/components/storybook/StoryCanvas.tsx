"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";
import LumiMark from "./LumiMark";
import { LAST_CHAPTER, chapterFromScroll, type Layout } from "./scene/timeline";
import type { StoryScene } from "./scene/createStoryScene";
import styles from "./StorybookLanding.module.css";

const MOBILE_QUERY = "(max-width: 860px)";

/** Renderers that rasterise on the CPU. The scene runs at a frame or two a second on them. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

let webglSupport: boolean | undefined;
/**
 * Probed once: creating a context is not free, and the answer never changes.
 *
 * "Supported" means a GPU will draw the scene, not merely that WebGL exists.
 * `failIfMajorPerformanceCaveat` makes the browser refuse a context it would
 * otherwise back with a software rasteriser; the renderer string catches the
 * browsers that hand one out anyway.
 */
function canUseWebGL(): boolean {
  if (webglSupport === undefined) {
    try {
      const probe = document.createElement("canvas");
      const attributes: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
      const gl = probe.getContext("webgl2", attributes) ?? probe.getContext("webgl", attributes);
      let renderer = "";
      if (gl) {
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
      }
      webglSupport = !!gl && !SOFTWARE_RENDERER.test(renderer);
      // Browsers cap live contexts; do not leave the probe's one behind.
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}
/**
 * Where the scene considers each chapter "arrived", as document offsets.
 *
 * Normally that is the chapter's centre. On a phone the scene owns the top of
 * the screen and a chapter's copy is often taller than the space below it, so
 * at the centre the heading would sit under Lumi. There a chapter arrives when
 * its heading reaches `HEADING_LINE` down the screen, just below the scene. The
 * opening and the ending keep their centres: their copy sits at the top.
 */
const HEADING_LINE = 0.42;
function chapterCenters(story: HTMLElement, mobile: boolean): number[] {
  const chapters = Array.from(story.querySelectorAll<HTMLElement>("[data-chapter]"));
  const viewport = window.innerHeight;
  return chapters.map((el, index) => {
    const ground = index === 0 || index === chapters.length - 1;
    const heading = mobile && !ground ? el.querySelector<HTMLElement>("h2") : null;
    if (heading) {
      const top = heading.getBoundingClientRect().top + window.scrollY;
      return top + viewport * (0.5 - HEADING_LINE);
    }
    const rect = el.getBoundingClientRect();
    return rect.top + window.scrollY + rect.height / 2;
  });
}

const subscribeNever = () => () => {};
/** The server cannot know, so it renders the canvas and the client corrects it. */
const assumeWebGL = () => true;

/**
 * The 3D stage behind the story. It owns nothing the page needs to be read:
 * all copy is HTML above it, so a browser without WebGL — or a visitor who
 * never downloads the scene — still gets the whole page.
 *
 * `storyRef` is the element whose `[data-chapter]` children define the scroll
 * timeline; `level` is the autonomy level picked in the trust chapter.
 */
export default function StoryCanvas({
  storyRef,
  level,
}: {
  storyRef: React.RefObject<HTMLElement | null>;
  level: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<StoryScene | null>(null);
  /** Asks for a frame. Under reduced motion nothing else would draw one. */
  const wakeRef = useRef<() => void>(() => {});
  const reduced = useStaticMotion();
  // Read through useSyncExternalStore so server and first client render agree
  // without a setState inside an effect.
  const supported = useSyncExternalStore(subscribeNever, canUseWebGL, assumeWebGL);
  // "pending" until the scene has drawn once; "failed" if loading it threw or
  // the device could not keep it moving. Failure is final for this page view.
  const [progress, setProgress] = useState<"pending" | "live" | "failed">("pending");
  const status = !supported || progress === "failed" ? "fallback" : progress;
  const failedRef = useRef(false);

  useEffect(() => {
    sceneRef.current?.setLevel(level);
    wakeRef.current();
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const story = storyRef.current;
    if (!canvas || !stage || !story || !supported || failedRef.current) return;

    let disposed = false;
    let scene: StoryScene | null = null;
    let raf = 0;
    let onScreen = true;
    let centers: number[] = [];
    const mobile = window.matchMedia(MOBILE_QUERY);
    const coarse = window.matchMedia("(pointer: coarse)");
    const layoutNow = (): Layout => (mobile.matches ? "mobile" : "desktop");

    const measure = () => {
      centers = chapterCenters(story, mobile.matches);
    };
    const draw = (now: number) => {
      if (!scene) return;
      scene.setChapter(chapterFromScroll(centers, window.scrollY + window.innerHeight / 2));
      scene.render(now);
    };
    const loop = (now: number) => {
      raf = 0;
      draw(now);
      // Reduced motion draws on demand only; otherwise keep the scene alive
      // while it is visible and the tab is in front.
      if (!disposed && !reduced && onScreen && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const wake = () => {
      if (!raf && scene) raf = requestAnimationFrame(loop);
    };
    wakeRef.current = wake;

    let lastWidth = 0;
    let lastHeight = 0;
    const resize = () => {
      if (!scene) return;
      const { clientWidth, clientHeight } = stage;
      if (clientWidth === lastWidth && clientHeight === lastHeight) return;
      // On touch devices the address bar sliding away resizes the viewport on
      // every scroll; following that would hitch, and the stage is sized in
      // lvh so it should not move anyway. Anywhere else a small change is a
      // real one (devtools, a downloads bar) and ignoring it stretches the
      // picture and puts Lumi somewhere other than where a click lands.
      if (coarse.matches && clientWidth === lastWidth && Math.abs(clientHeight - lastHeight) < 120) return;
      lastWidth = clientWidth;
      lastHeight = clientHeight;
      scene.setLayout(layoutNow());
      scene.resize(clientWidth, clientHeight);
      measure();
      wake();
    };

    /** Client coordinates to the stage's -1..1 space (the stage is 100lvh, not innerHeight). */
    const toStage = (event: MouseEvent): [number, number] => {
      const rect = stage.getBoundingClientRect();
      return [
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      ];
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      scene?.setPointer(...toStage(event), true);
    };
    const onPointerLeave = () => scene?.setPointer(0, 0, false);
    const onClick = (event: MouseEvent) => {
      // Lumi sits behind the page, so taps arrive on whatever HTML is on top.
      // Leave real controls alone and treat everything else as a poke.
      const target = event.target as Element | null;
      if (target?.closest("a, button, input, textarea, select, summary, [role='button']")) return;
      scene?.poke(...toStage(event));
    };
    const onVisibility = () => {
      if (!document.hidden) wake();
    };

    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      if (onScreen) wake();
    });
    const resizeObserver = new ResizeObserver(() => {
      resize();
      measure();
      wake();
    });

    // three.js is the heaviest thing on the page; load it after first paint so
    // the copy and the call to action never wait on it.
    void import("./scene/createStoryScene")
      .then(({ createStoryScene }) => {
        if (disposed) return;
        scene = createStoryScene(canvas, {
          layout: layoutNow(),
          reducedMotion: reduced,
          lowPower: mobile.matches || (navigator.hardwareConcurrency ?? 8) <= 4,
          // Called from inside a frame; leave that frame to finish first.
          onGiveUp: () =>
            setTimeout(() => {
              if (disposed) return;
              const given = scene;
              failedRef.current = true;
              teardown();
              // The canvas stays mounted, so teardown keeps the context; this
              // scene is never coming back, so hand it to the browser now.
              given?.loseContext();
              setProgress("failed");
            }, 0),
        });
        sceneRef.current = scene;
        scene.setLevel(level);
        resize();
        observer.observe(stage);
        resizeObserver.observe(stage);
        resizeObserver.observe(story);
        window.addEventListener("scroll", wake, { passive: true });
        window.addEventListener("pointermove", onPointerMove, { passive: true });
        document.documentElement.addEventListener("pointerleave", onPointerLeave);
        window.addEventListener("click", onClick);
        document.addEventListener("visibilitychange", onVisibility);
        mobile.addEventListener("change", resize);
        // Reveal only once a frame exists, so the canvas never flashes empty.
        requestAnimationFrame((now) => {
          if (disposed) return;
          draw(now);
          setProgress("live");
          wake();
        });
      })
      .catch(() => {
        if (disposed) return;
        failedRef.current = true;
        setProgress("failed");
      });

    const teardown = () => {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("scroll", wake);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVisibility);
      mobile.removeEventListener("change", resize);
      const finished = scene;
      scene = null;
      finished?.dispose();
      sceneRef.current = null;
      // Browsers cap live GL contexts, so hand this one back — but only on a
      // real unmount. When `reduced` flips, the effect re-runs on the same
      // canvas, and a lost context there would leave the next scene blank.
      if (finished) {
        setTimeout(() => {
          if (!canvas.isConnected) finished.loseContext();
        }, 0);
      }
      wakeRef.current = () => {};
    };
    return teardown;
    // `level` is pushed through its own effect; re-creating the scene for it
    // would restart the story.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, storyRef, supported]);

  // Without the scene, the stand-in Lumi still has to keep out of the copy. On
  // a phone the copy is at the top of the screen at ground level (the opening
  // and the ending) and at the bottom everywhere else, so the mark swaps ends.
  const fallback = status === "fallback";
  useEffect(() => {
    const stage = stageRef.current;
    const story = storyRef.current;
    if (!fallback || !stage || !story) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const mobile = window.matchMedia(MOBILE_QUERY).matches;
      const c = chapterFromScroll(chapterCenters(story, mobile), window.scrollY + window.innerHeight / 2);
      stage.dataset.ground = String(c < 0.5 || c > LAST_CHAPTER - 0.5);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [fallback, storyRef]);

  return (
    <div ref={stageRef} className={styles.stage} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} data-live={status === "live"} />
      {fallback && (
        <div className={styles.fallback}>
          <LumiMark size={260} className={styles.fallbackLumi} />
        </div>
      )}
    </div>
  );
}
