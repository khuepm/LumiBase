"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";
import styles from "./FooterMotion.module.css";

export default function FooterMotion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const footerRef = useRef<HTMLElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const userPaused = useRef(false);
  const updatePlayback = useRef<(() => void) | null>(null);
  const reducedMotion = useStaticMotion();
  const [videoReady, setVideoReady] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const footer = footerRef.current;
    const video = footer?.querySelector<HTMLVideoElement>("[data-footer-video]");
    if (!footer) return;

    // Check the preference immediately as well as through the reactive hook:
    // the server snapshot cannot know the user's motion preference.
    const reduced = reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const bounds = footer.getBoundingClientRect();
    let inView = bounds.top < window.innerHeight && bounds.bottom > 0;
    let nearby = bounds.top < window.innerHeight + 250 && bounds.bottom > -250;
    let disposed = false;
    let playPending = false;
    let mediaFailed = false;

    if (inView || reduced) footer.dataset.revealed = "true";
    if (!inView && !reduced) footer.dataset.motionReady = "true";

    const syncPlayback = () => {
      if (!video || disposed) return;
      if (nearby && !reduced && !mediaFailed && !video.getAttribute("src") && video.dataset.src) {
        video.src = video.dataset.src;
        video.load();
      }
      const shouldPlay = inView && !document.hidden && !reduced && !userPaused.current && !mediaFailed;
      if (!shouldPlay) {
        video.pause();
        return;
      }
      if (!video.getAttribute("src") || !video.paused || playPending) return;
      playPending = true;
      void video.play().then(() => {
        if (disposed) return;
        playPending = false;
        // Visibility or the user's choice may have changed while play awaited data.
        if (!inView || document.hidden || reduced || userPaused.current) video.pause();
      }).catch(() => {
        if (disposed) return;
        playPending = false;
        setPlaying(false);
      });
    };

    const onReady = () => setVideoReady(true);
    const onPlaying = () => {
      setVideoReady(true);
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onError = () => {
      mediaFailed = true;
      video?.pause();
      // Reset the failed media resource so the poster is shown again.
      video?.removeAttribute("src");
      video?.load();
      setPlaying(false);
      setVideoReady(false);
    };
    video?.addEventListener("loadeddata", onReady);
    video?.addEventListener("playing", onPlaying);
    video?.addEventListener("pause", onPause);
    video?.addEventListener("error", onError);
    document.addEventListener("visibilitychange", syncPlayback);
    updatePlayback.current = syncPlayback;

    // One observer starts the download shortly before arrival; the other keeps
    // offscreen media paused and reveals the server-rendered footer content.
    const preloadObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (!entry) return;
      nearby = entry.isIntersecting;
      syncPlayback();
    }, { rootMargin: "250px" });
    const visibilityObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (!entry) return;
      inView = entry.isIntersecting;
      if (inView) footer.dataset.revealed = "true";
      syncPlayback();
    });
    preloadObserver?.observe(footer);
    visibilityObserver?.observe(footer);

    const measureVisibility = () => {
      const rect = footer.getBoundingClientRect();
      inView = rect.top < window.innerHeight && rect.bottom > 0;
      nearby = rect.top < window.innerHeight + 250 && rect.bottom > -250;
      syncPlayback();
    };
    // Readable content and offscreen pausing also work without observers.
    if (!visibilityObserver) {
      footer.dataset.revealed = "true";
      window.addEventListener("scroll", measureVisibility, { passive: true });
      window.addEventListener("resize", measureVisibility);
    }
    syncPlayback();

    return () => {
      disposed = true;
      updatePlayback.current = null;
      preloadObserver?.disconnect();
      visibilityObserver?.disconnect();
      window.removeEventListener("scroll", measureVisibility);
      window.removeEventListener("resize", measureVisibility);
      document.removeEventListener("visibilitychange", syncPlayback);
      video?.removeEventListener("loadeddata", onReady);
      video?.removeEventListener("playing", onPlaying);
      video?.removeEventListener("pause", onPause);
      video?.removeEventListener("error", onError);
      video?.pause();
    };
  }, [reducedMotion]);

  useEffect(() => {
    const footer = footerRef.current;
    const cursor = cursorRef.current;
    const ring = ringRef.current;
    const pill = pillRef.current;
    if (!footer || !cursor || !ring || !pill || reducedMotion) return;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let active = false;
    let targetX = 0;
    let targetY = 0;
    let pillX = 0;
    let pillY = 0;

    const hide = () => {
      active = false;
      cursor.dataset.active = "false";
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const drawPill = () => {
      frame = 0;
      if (!active) return;
      pillX += (targetX - pillX) * 0.08;
      pillY += (targetY - pillY) * 0.08;
      pill.style.transform = `translate3d(${pillX + 26}px, ${pillY + 26}px, 0)`;
      if (Math.abs(targetX - pillX) + Math.abs(targetY - pillY) > 0.2) {
        frame = requestAnimationFrame(drawPill);
      }
    };
    const move = (event: PointerEvent) => {
      if (!finePointer.matches || motionPreference.matches || document.hidden || event.pointerType === "touch") {
        hide();
        return;
      }
      const rect = footer.getBoundingClientRect();
      targetX = event.clientX - rect.left;
      targetY = event.clientY - rect.top;
      if (!active) {
        pillX = targetX;
        pillY = targetY;
      }
      active = true;
      cursor.dataset.active = "true";
      cursor.dataset.interactive = String(event.target instanceof Element && !!event.target.closest(
        "a, button, input, select, textarea, [role='button'], [contenteditable='true']"
      ));
      ring.style.transform = `translate3d(${targetX - 24}px, ${targetY - 24}px, 0)`;
      if (!frame) frame = requestAnimationFrame(drawPill);
    };

    footer.addEventListener("pointermove", move);
    footer.addEventListener("pointerleave", hide);
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    finePointer.addEventListener("change", hide);
    motionPreference.addEventListener("change", hide);

    return () => {
      hide();
      footer.removeEventListener("pointermove", move);
      footer.removeEventListener("pointerleave", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
      finePointer.removeEventListener("change", hide);
      motionPreference.removeEventListener("change", hide);
    };
  }, [reducedMotion]);

  const togglePlayback = () => {
    const video = footerRef.current?.querySelector<HTMLVideoElement>("[data-footer-video]");
    if (!video) return;
    userPaused.current = !video.paused;
    updatePlayback.current?.();
  };

  return (
    <footer ref={footerRef} className={className} id="contact">
      {children}
      <button
        type="button"
        className={styles.motionControl}
        hidden={!videoReady || reducedMotion}
        onClick={togglePlayback}
        aria-label={playing ? "Pause background video" : "Play background video"}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="m3 1 8 5-8 5z" />}
        </svg>
        <span>{playing ? "Pause video" : "Play video"}</span>
      </button>
      <div ref={cursorRef} className={styles.cursor} aria-hidden="true">
        <div ref={ringRef} className={styles.ring}><span /></div>
        <div ref={pillRef} className={styles.pill}>SAY HELLO!</div>
      </div>
    </footer>
  );
}
