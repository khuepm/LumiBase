import Image from "next/image";
import Link from "next/link";

const orbits = [
  { size: 266, dur: 26, planet: "/assets/planet-red.png", p: 22, angle: 20 },
  { size: 366, dur: 34, planet: "/assets/planet-blue.png", p: 32, angle: 200 },
  { size: 520, dur: 44, planet: "/assets/planet-green.png", p: 26, angle: 120 },
  { size: 650, dur: 60, planet: "/assets/planet-genius.png", p: 56, angle: 300 },
  { size: 820, dur: 78, planet: "/assets/planet-magician.png", p: 64, angle: 60 },
  { size: 980, dur: 96, planet: "/assets/planet-blue.png", p: 20, angle: 160 },
];

/** Hero — display headline over an orbital solar system. */
export default function Hero() {
  return (
    <section className="relative px-5 pt-14 text-center md:pt-20">
      <h1
        className="m-0 text-white [font:700_44px/50px_var(--font-sans)] sm:[font:700_60px/70px_var(--font-sans)] md:[font:700_75px/86px_var(--font-sans)]"
        style={{ letterSpacing: "-0.2px" }}
      >
        Your content,
        <br />
        operated by AI.
      </h1>
      <p
        className="mx-auto mt-6 max-w-[430px]"
        style={{
          font: "500 20px/33px var(--font-sans, inherit)",
          color: "var(--color-text-secondary)",
        }}
      >
        LumiBase is the Content Operating System — agents do the operational
        work, you set the intent and hold the veto.
      </p>
      <div className="mt-8 flex justify-center">
        <Link
          href="https://docs.lumibase.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-pill btn-glass h-[46px] pl-4 pr-5 text-sm"
        >
          <span
            className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white"
            style={{ boxShadow: "var(--shadow-sm)" }}
          >
            <Image
              src="/assets/logo-mark.svg"
              alt=""
              width={12}
              height={12}
              style={{ filter: "invert(1)" }}
            />
          </span>
          <span>Read the docs</span>
        </Link>
      </div>

      {/* Solar system */}
      <div className="orbit-wrap mt-2" aria-hidden>
        <div className="orbit-stage">
          {orbits.map((o, i) => (
            <div
              key={i}
              className="absolute left-1/2 top-1/2 rounded-full"
              style={{
                width: o.size,
                height: o.size,
                marginLeft: -o.size / 2,
                marginTop: -o.size / 2,
                border: "1px solid rgba(255,255,255,0.10)",
                animation: `orbit-spin ${o.dur}s linear infinite`,
                animationDelay: `-${(o.dur * o.angle) / 360}s`,
              }}
            >
              <div
                className="absolute top-0"
                style={{
                  left: `calc(50% - ${o.p / 2}px)`,
                  width: o.p,
                  height: o.p,
                  marginTop: -o.p / 2,
                  animation: `orbit-spin ${o.dur}s linear infinite reverse`,
                  animationDelay: `-${(o.dur * o.angle) / 360}s`,
                }}
              >
                <Image
                  src={o.planet}
                  alt=""
                  width={o.p}
                  height={o.p}
                  className="block"
                  style={{ filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.5))" }}
                />
              </div>
            </div>
          ))}
          {/* Central glossy core */}
          <div
            className="absolute left-1/2 top-1/2 overflow-hidden rounded-full"
            style={{
              width: 190,
              height: 190,
              marginLeft: -95,
              marginTop: -95,
              background: "linear-gradient(180deg,#fff 0%,#cfcfcf 100%)",
              boxShadow: "0 0 80px rgba(123,97,255,0.35), var(--shadow-lg)",
            }}
          />
        </div>
      </div>
    </section>
  );
}
