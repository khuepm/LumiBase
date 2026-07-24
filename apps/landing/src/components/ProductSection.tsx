import Link from "next/link";
import Badge, { type BadgeTone } from "@/components/cosmic/Badge";
import FeatureCard from "@/components/cosmic/FeatureCard";
import Scene, { ParallaxItem } from "@/components/scroll/Scene";
import WipeTitle from "@/components/scroll/WipeTitle";
import EclipsePhaseScrub from "@/components/scroll/EclipsePhaseScrub";
import { PHASE_HUES } from "@/components/EclipseMark";
import { RevealGroup, RevealItem } from "@/components/motion";

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

/** Column-based drift so grid cards parallax at slightly different rates. */
const DRIFT = [0, 26, -20];

/**
 * Product section — one scroll scene per pillar: the eclipse-phase glyph and
 * title wipe are scrubbed by this scene's own progress, then a 3-column
 * feature grid with per-column parallax.
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
  const [hue] = PHASE_HUES[phase] ?? PHASE_HUES[0]!;
  return (
    <Scene id={id} className="mx-auto max-w-[1200px] px-5 pt-[90px] md:pt-[140px]">
      <div className="mb-4 flex items-center justify-center">
        <EclipsePhaseScrub phase={phase} size={84} />
      </div>
      <WipeTitle label={`[ ${no} / ${title.toUpperCase()} ]`} title={title}>
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
                background: hue,
                boxShadow: `0 0 8px ${hue}`,
              }}
            />
            <span>{cta}</span>
          </Link>
        </div>
      </WipeTitle>

      <RevealGroup className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-16 lg:grid-cols-3">
        {features.map((f, i) => (
          <RevealItem
            key={f.title}
            className={f.span === 2 ? "sm:col-span-2" : undefined}
          >
            <ParallaxItem className="h-full" drift={DRIFT[i % 3] ?? 0}>
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
            </ParallaxItem>
          </RevealItem>
        ))}
      </RevealGroup>
    </Scene>
  );
}
