"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const getSnapshot = () =>
  typeof window !== "undefined" && !!window.matchMedia?.(QUERY).matches;

/** The server cannot know the media query, so it always renders the motion path. */
const getServerSnapshot = () => false;

/**
 * prefers-reduced-motion, hydration-safe. Subscribing through
 * useSyncExternalStore rather than a mount effect keeps the server and first
 * client render in agreement (both false) without a setState-in-effect, and it
 * also picks up changes if the user flips the OS setting mid-session.
 */
export function useStaticMotion() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
