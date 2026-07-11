import Link from "next/link";
import { EclipseMark } from "@/components/EclipseMark";

/** Corona streaks — long soft rays rotating imperceptibly behind the moon. */
function CoronaRays() {
  const rays = Array.from({ length: 14 }, (_, i) => {
    const angle = (360 / 14) * i;
    const len = i % 3 === 0 ? 300 : i % 2 === 0 ? 250 : 210;
    return { angle, len };
  });
  return (
    <svg
      className="eclipse-corona-rays absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      width={640}
      height={640}
      viewBox="0 0 640 640"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="hero-ray" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff8c00" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#e6500a" stopOpacity="0" />
        </linearGradient>
      </defs>
      {rays.map((r) => (
        <rect
          key={r.angle}
          x={150}
          y={318}
          width={r.len}
          height={4}
          rx={2}
          fill="url(#hero-ray)"
          transform={`rotate(${r.angle} 320 320)`}
        />
      ))}
    </svg>
  );
}

/** The tiny spaceship — cream hull, amber exhaust, transiting at totality. */
function TinyShip() {
  return (
    <svg width={44} height={26} viewBox="0 0 44 26" fill="none" aria-hidden>
      <path d="M12 13 H1" stroke="#ffedd7" strokeWidth="1.1" strokeLinecap="round" opacity="0.45" />
      <path d="M12 13 H6" stroke="#ffa000" strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
      <path
        d="M42 13 C 39.5 8.6 32.5 7.9 23 9.2 L 18 13 L 23 16.8 C 32.5 18.1 39.5 17.4 42 13 Z"
        fill="#ffedd7"
      />
      <path d="M26 9.6 L 21 5.6 L 19 11 Z" fill="#f6e0c6" />
      <path d="M26 16.4 L 21 20.4 L 19 15 Z" fill="#f6e0c6" />
      <circle cx="33" cy="13" r="1.8" fill="#100904" />
      <circle cx="28" cy="13" r="1.4" fill="#100904" opacity="0.75" />
    </svg>
  );
}

/** Hero — editorial headline over a total solar eclipse, spaceship in transit. */
export default function Hero() {
  return (
    <section className="relative px-5 pt-14 text-center md:pt-20">
      <p className="label-mono m-0">
        [ THE CONTENT OPERATING SYSTEM · TOTALITY&nbsp;EDITION ]
      </p>
      <h1
        className="mx-auto mb-0 mt-5 max-w-[900px] uppercase [font:800_44px/48px_var(--font-sans)] sm:[font:800_62px/64px_var(--font-sans)] md:[font:800_80px/80px_var(--font-sans)]"
        style={{ letterSpacing: "-0.01em", color: "var(--foreground)" }}
      >
        Your content,
        <br />
        operated by{" "}
        <span style={{ color: "var(--color-accent)" }}>AI.</span>
      </h1>
      <p
        className="font-serif-body mx-auto mt-6 max-w-[470px]"
        style={{
          font: "400 19px/31px var(--font-serif-stack)",
          color: "var(--color-text-secondary)",
        }}
      >
        LumiBase is the Content Operating System — agents do the operational
        work, you set the intent and hold the veto.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Link
          href="https://github.com/khuepm/lumibase"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-pill btn-solid btn-md"
        >
          <span>Start building</span>
        </Link>
        <Link
          href="https://docs.lumibase.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-pill btn-glass h-[46px] pl-4 pr-5 text-sm"
        >
          <EclipseMark size={20} />
          <span>Read the docs</span>
        </Link>
      </div>

      {/* ── Total solar eclipse, spaceship in transit ─────────── */}
      <div className="eclipse-wrap mt-6" aria-hidden>
        <div className="eclipse-stage">
          <CoronaRays />

          {/* Breathing corona glow */}
          <div
            className="eclipse-corona absolute left-1/2 top-1/2 h-[460px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(255,160,0,0.55) 34%, rgba(230,80,10,0.3) 52%, rgba(230,80,10,0) 72%)",
            }}
          />

          {/* Chromosphere ring */}
          <div
            className="absolute left-1/2 top-1/2 h-[268px] w-[268px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              boxShadow:
                "0 0 0 2.5px rgba(255,160,0,0.95), 0 0 0 3.5px rgba(255,237,215,0.5), var(--glow-corona)",
            }}
          />

          {/* Moon at totality */}
          <div
            className="absolute left-1/2 top-1/2 h-[264px] w-[264px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 36% 32%, #2c1c0e 0%, #150c05 55%, #100904 100%)",
            }}
          />

          {/* Diamond-ring flare */}
          <div
            className="absolute rounded-full"
            style={{
              left: "calc(50% + 88px)",
              top: "calc(50% - 102px)",
              width: 10,
              height: 10,
              background: "#ffedd7",
              boxShadow:
                "0 0 14px 5px rgba(255,237,215,0.75), 0 0 44px 16px rgba(255,160,0,0.4)",
            }}
          />

          {/* The tiny spaceship, crossing right at totality */}
          <div className="eclipse-ship absolute left-1/2 top-1/2 -ml-[22px] -mt-[13px]">
            <TinyShip />
          </div>

          {/* Observation caption — editorial deadpan */}
          <div
            className="label-mono absolute bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap"
            style={{ letterSpacing: "0.18em" }}
          >
            FIG. 01 — TOTALITY, SPACECRAFT IN TRANSIT&nbsp;&nbsp;[ NOT TO SCALE ]
          </div>
        </div>
      </div>
    </section>
  );
}
