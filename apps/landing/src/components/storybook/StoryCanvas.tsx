"use client";

import { useEffect, useRef, useState } from "react";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";
import LumiMark from "./LumiMark";
import { chapterFromScroll, type Layout } from "./scene/timeline";
import type { StoryScene } from "./scene/createStoryScene";
import styles from "./StorybookLanding.module.css";

const MOBILE_QUERY = "(max-width: 860px)";

function canUseWebGL(): boolean {
  try {
    const probe = document.createElement("canvas");
    return !!(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

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
  const reduced = useStaticMotion();
  // "pending" until the scene has drawn once; "fallback" if it never can.
  const [status, setStatus] = useState<"pending" | "live" | "fallback">("pending");

  useEffect(() => {
    sceneRef.current?.setLevel(level);
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const story = storyRef.current;
    if (!canvas || !stage || !story) return;
    if (!canUseWebGL()) {
      setStatus("fallback");
      return;
    }

    let disposed = false;
    let scene: StoryScene | null = null;
    let raf = 0;
    let onScreen = true;
    let centers: number[] = [];
    const mobile = window.matchMedia(MOBILE_QUERY);
    const layoutNow = (): Layout => (mobile.matches ? "mobile" : "desktop");

    const measure = () => {
      centers = Array.from(story.querySelectorAll<HTMLElement>("[data-chapter]")).map((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top + window.scrollY + rect.height / 2;
      });
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
      if (!reduced && onScreen && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const wake = () => {
      if (!raf && scene) raf = requestAnimationFrame(loop);
    };

    let lastWidth = 0;
    let lastHeight = 0;
    const resize = () => {
      if (!scene) return;
      const { clientWidth, clientHeight } = stage;
      // Mobile browsers resize the viewport as the address bar slides away;
      // rebuilding render targets for that would hitch every scroll.
      if (clientWidth === lastWidth && Math.abs(clientHeight - lastHeight) < 120) return;
      lastWidth = clientWidth;
      lastHeight = clientHeight;
      scene.setLayout(layoutNow());
      scene.resize(clientWidth, clientHeight);
      measure();
      wake();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      scene?.setPointer((event.clientX / window.innerWidth) * 2 - 1, 1 - (event.clientY / window.innerHeight) * 2, true);
    };
    const onPointerLeave = () => scene?.setPointer(0, 0, false);
    const onClick = (event: MouseEvent) => {
      // Lumi sits behind the page, so taps arrive on whatever HTML is on top.
      // Leave real controls alone and treat everything else as a poke.
      const target = event.target as Element | null;
      if (target?.closest("a, button, input, textarea, select, summary, [role='button']")) return;
      scene?.poke((event.clientX / window.innerWidth) * 2 - 1, 1 - (event.clientY / window.innerHeight) * 2);
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
          setStatus("live");
          wake();
        });
      })
      .catch(() => {
        if (!disposed) setStatus("fallback");
      });

    return () => {
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
      scene?.dispose();
      sceneRef.current = null;
    };
    // `level` is pushed through its own effect; re-creating the scene for it
    // would restart the story.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, storyRef]);

  return (
    <div ref={stageRef} className={styles.stage} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} data-live={status === "live"} />
      {status === "fallback" && (
        <div className={styles.fallback}>
          <LumiMark size={260} className={styles.fallbackLumi} />
        </div>
      )}
    </div>
  );
}
