import Link from "next/link";
import Badge, { type BadgeTone } from "@/components/cosmic/Badge";
import FeatureCard from "@/components/cosmic/FeatureCard";
import { EclipsePhase } from "@/components/EclipseMark";
import { Reveal, RevealGroup, RevealItem } from "@/components/motion";

export interface SectionFeature {
  title: string;
  desc: string;
  span?: number;
  node?: React.ReactNode;
  bg?: string;
  badge?: string;
  badgeTone?: BadgeTone;
  vh?: number;
}

export interface SectionData {
  id: string;
  index: number;
  phase: 0 | 1 | 2 | 3;
  title: string;
  tagline: string;
  cta: string;
  ctaHref: string;
  features: SectionFeature[];
}

/**
 * Product section — editorial numbered header: eclipse-phase glyph, mono
 * index, uppercase display title, serif tagline, then a 3-column feature
 * grid. One per product pillar.
 */
export default function ProductSection({
  id,
  index,
  phase,
  title,
  tagline,
  cta,
  ctaHref,
  features,
}: SectionData) {
  const no = String(index).padStart(2, "0");
  return (
    <section id={id} className="mx-auto max-w-[1200px] px-5 pt-[90px] md:pt-[120px]">
      <hr className="rule-dashed mb-10" />
      <Reveal className="flex flex-col items-center text-center">
        <div className="relative mb-4 flex items-center justify-center">
          <EclipsePhase phase={phase} size={84} />
        </div>
        <p className="label-mono m-0">
          [ {no} / {title.toUpperCase()} ]
        </p>
        <h2
          className="m-0 mt-3 uppercase [font:800_34px/38px_var(--font-sans)] md:[font:800_48px/50px_var(--font-sans)]"
          style={{ letterSpacing: "-0.01em", color: "var(--foreground)" }}
        >
          {title}
        </h2>
        <p
          className="font-serif-body mx-auto mt-3.5 max-w-[480px]"
          style={{
            font: "400 19px/31px var(--font-serif-stack)",
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
              style={{
                background: "var(--color-accent)",
                boxShadow: "0 0 8px rgba(230,80,10,0.8)",
              }}
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
                  <Badge tone={f.badgeTone ?? "accent"}>{f.badge}</Badge>
                ) : undefined)
              }
            />
          </RevealItem>
        ))}
      </RevealGroup>
    </section>
  );
}
