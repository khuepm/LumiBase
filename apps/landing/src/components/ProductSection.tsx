import Image from "next/image";
import Link from "next/link";
import Badge, { type BadgeTone } from "@/components/cosmic/Badge";
import FeatureCard from "@/components/cosmic/FeatureCard";
import { Reveal, RevealGroup, RevealItem } from "@/components/motion";

export interface SectionFeature {
  title: string;
  desc: string;
  span?: number;
  node?: React.ReactNode;
  bg?: string;
  img?: string;
  imgW?: number;
  badge?: string;
  badgeTone?: BadgeTone;
  vh?: number;
}

export interface SectionData {
  id: string;
  planet: string;
  glow: string;
  title: string;
  tagline: string;
  cta: string;
  ctaHref: string;
  features: SectionFeature[];
}

/**
 * Product section — centred planet + title + tagline + CTA pill, then a
 * 3-column feature grid. One per product pillar.
 */
export default function ProductSection({
  id,
  planet,
  glow,
  title,
  tagline,
  cta,
  ctaHref,
  features,
}: SectionData) {
  return (
    <section id={id} className="mx-auto max-w-[1200px] px-5 pt-[90px] md:pt-[120px]">
      <Reveal className="flex flex-col items-center text-center">
        {/*
         * Glow is rendered as a decoupled radial-gradient halo behind the
         * planet rather than via `filter: drop-shadow()` on the <Image>.
         * The planet PNGs are indexed-color with tRNS (palette) transparency,
         * and some mobile GPUs mis-resolve that alpha during the drop-shadow
         * SourceAlpha pass when the element is on its own composited layer
         * (promoted here by the Reveal transform) with no clipping ancestor —
         * painting the whole bounding box as an opaque black square. The
         * in-card planets escape it only because they sit inside overflow-hidden
         * cards. A gradient halo doesn't touch the image alpha, so it renders
         * consistently across desktop and mobile.
         */}
        <div className="relative mb-6 flex items-center justify-center">
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 h-[150px] w-[150px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: `radial-gradient(circle, ${glow} 0%, transparent 70%)` }}
          />
          <Image src={planet} alt="" width={96} height={96} className="relative" />
        </div>
        <h2
          className="m-0 text-white [font:700_34px/40px_var(--font-sans)] md:[font:700_48px/56px_var(--font-sans)]"
          style={{ letterSpacing: "-0.4px" }}
        >
          {title}
        </h2>
        <p
          className="mx-auto mt-3.5 max-w-[460px]"
          style={{
            font: "500 20px/33px var(--font-sans, inherit)",
            color: "var(--color-text-secondary)",
          }}
        >
          {tagline}
        </p>
        <div className="mt-7">
          <Link
            href={ctaHref}
            {...(ctaHref.startsWith("http")
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
            className="btn-pill btn-glass btn-md"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: glow }}
            />
            <span>{cta}</span>
          </Link>
        </div>
      </Reveal>

      <RevealGroup className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-16 lg:grid-cols-3">
        {features.map((f) => (
          <RevealItem
            key={f.title}
            className={f.span === 2 ? "sm:col-span-2" : undefined}
          >
            <FeatureCard
              title={f.title}
              description={f.desc}
              visualHeight={f.vh ?? 190}
              visualBg={f.bg}
              visual={
                f.node ??
                (f.badge ? (
                  <Badge tone={f.badgeTone ?? "violet"}>{f.badge}</Badge>
                ) : f.img ? (
                  <Image
                    src={f.img}
                    alt=""
                    width={f.imgW ?? 120}
                    height={f.imgW ?? 120}
                    style={{ filter: `drop-shadow(0 0 36px ${glow})` }}
                  />
                ) : undefined)
              }
            />
          </RevealItem>
        ))}
      </RevealGroup>
    </section>
  );
}
