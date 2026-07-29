"use client";

import { useEffect, useRef } from "react";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * GlitterWarp — animated starfield warp tunnel with glittering sparkle flashes.
 *
 * Ported from the Framer "Glitter Wrap" component: same physics and the same
 * performance discipline (props read live from a ref so control changes never
 * rebuild the star pool, colour strings cached and per-star opacity carried on
 * globalAlpha so the hot loop allocates nothing, framerate-independent trail
 * decay, ResizeObserver bail on no-op resizes so the trail buffer isn't wiped).
 *
 * Under prefers-reduced-motion it draws a populated still frame and stops.
 */

type Props = {
  particleCount?: number;
  color1?: string;
  color2?: string;
  color3?: string;
  /** 1–10 */
  speed?: number;
  /** 1–100 — spawn spread */
  density?: number;
  /** 0–20 */
  starSize?: number;
  /** 1–30 */
  focalDepth?: number;
  /** 0–10 */
  turbulence?: number;
  /** 0–100 */
  brightness?: number;
  /** 0–10 */
  glitterIntensity?: number;
  /** 0–100 */
  trailAmount?: number;
  reverse?: boolean;
};

const DEFAULTS: Required<Props> = {
  particleCount: 420,
  color1: "#ffffff",
  color2: "#b06bff",
  color3: "#29d8e6",
  speed: 3,
  density: 100,
  starSize: 8,
  focalDepth: 13,
  turbulence: 0,
  brightness: 85,
  glitterIntensity: 3,
  trailAmount: 88,
  reverse: false,
};

function parseColor(input: string): [number, number, number, number] {
  if (!input) return [255, 255, 255, 1];
  const s = input.trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const num = parseInt(hex, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = (m[1] ?? "").split(",").map((p) => parseFloat(p.trim()));
    return [
      parts[0] || 0,
      parts[1] || 0,
      parts[2] || 0,
      parts[3] == null ? 1 : parts[3],
    ];
  }
  return [255, 255, 255, 1];
}

export default function GlitterWarp(props: Props) {
  const reduced = useStaticMotion();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  // Latest props, read fresh each frame so tweaks don't tear down the loop.
  const propsRef = useRef({ ...DEFAULTS, ...props });
  propsRef.current = { ...DEFAULTS, ...props };

  // Cached parsed colours — avoids 3 regex parses per frame.
  const colorCacheRef = useRef({
    color1: "",
    color2: "",
    color3: "",
    parsed1: [255, 255, 255, 1] as [number, number, number, number],
    parsed2: [176, 107, 255, 1] as [number, number, number, number],
    parsed3: [41, 216, 230, 1] as [number, number, number, number],
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const getCachedColors = () => {
      const p = propsRef.current;
      const c = colorCacheRef.current;
      if (p.color1 !== c.color1) {
        c.color1 = p.color1;
        c.parsed1 = parseColor(p.color1);
      }
      if (p.color2 !== c.color2) {
        c.color2 = p.color2;
        c.parsed2 = parseColor(p.color2);
      }
      if (p.color3 !== c.color3) {
        c.color3 = p.color3;
        c.parsed3 = parseColor(p.color3);
      }
      return c;
    };

    type Star = {
      x: number;
      y: number;
      z: number;
      px: number;
      py: number;
      seed: number;
      vmul: number;
      colorIdx: number;
      flashUntil: number;
      nextFlash: number;
    };

    const stars: Star[] = [];
    let elapsed = 0;
    let lastT = performance.now();

    const cfg = () => {
      const p = propsRef.current;
      return {
        reverse: p.reverse,
        density: p.density,
        stepZ: p.speed * 0.0008,
        focalDepth: p.focalDepth / 100,
        starScale: p.starSize * 0.15,
        turbulence: p.turbulence * 0.2,
        glitter: p.glitterIntensity * 0.1,
        brightness: Math.min(1, p.brightness / 100),
        trail: p.trailAmount / 100,
      };
    };

    const resetStar = (s: Star, initial = false) => {
      const { density, reverse, focalDepth, glitter } = cfg();
      const angle = Math.random() * Math.PI * 2;
      const radius = (0.2 + Math.random() * 0.8) * (density / 15);
      s.x = Math.cos(angle) * radius;
      s.y = Math.sin(angle) * radius;
      if (reverse) {
        s.z = initial ? focalDepth + Math.random() * (1 - focalDepth) : focalDepth;
      } else {
        s.z = initial ? Math.random() : 1.0;
      }
      s.px = NaN;
      s.py = NaN;
      s.seed = Math.random() * 1000;
      s.vmul = 0.6 + Math.random() * 0.8;
      s.colorIdx = Math.floor(Math.random() * 3);
      s.flashUntil = 0;
      s.nextFlash =
        elapsed + 1 + Math.random() * 4 * (1 / Math.max(0.0001, glitter));
    };

    const makeStar = (): Star => ({
      x: 0,
      y: 0,
      z: 0,
      px: NaN,
      py: NaN,
      seed: 0,
      vmul: 1,
      colorIdx: 0,
      flashUntil: 0,
      nextFlash: 0,
    });

    const syncCount = () => {
      const count = Math.max(1, Math.floor(propsRef.current.particleCount));
      if (stars.length === count) return;
      if (stars.length > count) {
        stars.length = count;
      } else {
        while (stars.length < count) {
          const s = makeStar();
          resetStar(s, true);
          stars.push(s);
        }
      }
    };

    const resize = (entry?: ResizeObserverEntry) => {
      // Capped at 1.5 (not 2): this is a full-viewport background layer, and
      // the per-frame destination-out fill scales with pixel count.
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const cr = entry?.contentRect;
      const rectW =
        cr?.width || container.clientWidth || container.getBoundingClientRect().width;
      const rectH =
        cr?.height || container.clientHeight || container.getBoundingClientRect().height;
      const w = Math.max(1, Math.floor(rectW) || 600);
      const h = Math.max(1, Math.floor(rectH) || 400);

      // Bail when nothing changed — setting canvas.width wipes the trail buffer,
      // and ResizeObserver fires spuriously.
      const prev = sizeRef.current;
      if (prev.w === w && prev.h === h && prev.dpr === dpr) return;

      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
    };

    syncCount();
    resize();

    const ro = new ResizeObserver((entries) => resize(entries[0]));
    ro.observe(container);

    const drawFrame = (deltaSec: number) => {
      const {
        reverse,
        stepZ,
        focalDepth,
        starScale,
        turbulence,
        glitter,
        brightness,
        trail,
      } = cfg();

      syncCount();
      const colors = getCachedColors();
      const palette = [colors.parsed1, colors.parsed2, colors.parsed3];
      // Built once per frame, not per star — the rgba()-per-star version churned
      // ~120k short-lived strings/sec and its GC pauses caused visible stutter.
      const rgbStrs = [
        `rgb(${palette[0]![0]}, ${palette[0]![1]}, ${palette[0]![2]})`,
        `rgb(${palette[1]![0]}, ${palette[1]![1]}, ${palette[1]![2]})`,
        `rgb(${palette[2]![0]}, ${palette[2]![1]}, ${palette[2]![2]})`,
      ];

      const { w, h } = sizeRef.current;
      const cx = w / 2;
      const cy = h / 2;
      const projScale = Math.min(w, h) * 0.9;

      const dt = Math.max(0.001, Math.min(0.1, deltaSec)) * 60;

      // Framerate-independent trail decay: `trail` is the fraction of the
      // previous frame kept per 1/60s, raised to dt, so trail length is constant
      // at 60Hz/120Hz/variable. destination-out subtracts alpha, keeping the
      // canvas transparent so the page background shows through.
      const keep = Math.pow(Math.min(0.98, Math.max(0, trail)), dt);
      const trailAlpha = Math.max(0.02, 1 - keep);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0, 0, 0, ${trailAlpha})`;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i]!;

        const vz = stepZ * s.vmul * dt;
        if (reverse) {
          s.z += vz;
          if (s.z >= 1.0) {
            resetStar(s);
            continue;
          }
        } else {
          s.z -= vz;
          if (s.z <= focalDepth) {
            resetStar(s);
            continue;
          }
        }

        let tx = s.x;
        let ty = s.y;
        if (turbulence > 0) {
          const t = elapsed * 1.2 + s.seed;
          const amp = turbulence * (1 - s.z) * 0.25;
          tx += Math.sin(t + s.seed) * amp;
          ty += Math.cos(t * 1.13 + s.seed * 0.7) * amp;
        }

        const persp = focalDepth / Math.max(s.z, 0.0001);
        const sx = cx + tx * persp * projScale;
        const sy = cy + ty * persp * projScale;

        // Forward only: a reverse star is born past the edge and travels onto
        // screen, so culling on sight would kill it before it appears.
        if (!reverse && (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20)) {
          resetStar(s);
          continue;
        }

        let flashMult = 1;
        if (glitter > 0) {
          if (elapsed >= s.nextFlash && s.flashUntil < elapsed) {
            s.flashUntil = elapsed + 0.04 + Math.random() * 0.07;
            s.nextFlash =
              elapsed + 1 + Math.random() * 4 * (1 / Math.max(0.0001, glitter));
          }
          if (elapsed <= s.flashUntil) {
            flashMult = 1 + 2.5 * glitter;
          }
        }

        const sizePersp = Math.min(2.5, (focalDepth / Math.max(s.z, 0.0001)) * 0.6);
        const baseR = Math.max(0.25, starScale * (0.4 + sizePersp));
        const maxR = 1 + starScale * 2.5;
        const r = Math.min(baseR * flashMult, maxR);

        const lifeT = reverse ? s.z : 1 - s.z;
        const fadeIn = reverse
          ? Math.min(1, (s.z - focalDepth) / (1 - focalDepth) / 0.12)
          : 1;
        const a =
          Math.min(1, reverse ? 0.85 - lifeT * 0.6 : lifeT * 0.9 + 0.05) *
          fadeIn *
          brightness *
          (flashMult > 1 ? 1 : 0.85);

        const colStr = rgbStrs[s.colorIdx]!;

        if (!Number.isNaN(s.px) && !Number.isNaN(s.py)) {
          ctx.globalAlpha = a * 0.5;
          ctx.strokeStyle = colStr;
          ctx.lineWidth = Math.max(0.4, r * 0.4);
          ctx.beginPath();
          ctx.moveTo(s.px, s.py);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }

        // fillRect, not arc(): at sub-pixel radii a square reads identically
        // and skips per-star path tessellation.
        ctx.globalAlpha = a;
        ctx.fillStyle = colStr;
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);

        if (flashMult > 1) {
          const rf = Math.min(r * 1.4, maxR * 1.4);
          ctx.globalAlpha = a * 0.5;
          ctx.fillRect(sx - rf, sy - rf, rf * 2, rf * 2);
        }

        s.px = sx;
        s.py = sy;
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      elapsed += Math.min(0.1, Math.max(0, deltaSec));
    };

    if (reduced) {
      // Populated still frame, then stop.
      for (let i = 0; i < 80; i++) drawFrame(1 / 60);
      return () => ro.disconnect();
    }

    const loop = (t: number) => {
      const deltaSec = (t - lastT) / 1000;
      lastT = t;
      drawFrame(deltaSec);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
    // Single setup — every animated value is read from propsRef each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, display: "block" }}
      />
    </div>
  );
}
