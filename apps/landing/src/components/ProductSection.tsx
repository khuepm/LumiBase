import Link from "next/link";
import Badge, { type BadgeTone } from "@/components/cosmic/Badge";
import FeatureCard from "@/components/cosmic/FeatureCard";
import Scene, { ParallaxItem } from "@/components/scroll/Scene";
import WipeTitle from "@/components/scroll/WipeTitle";
import EclipsePhaseScrub from "@/components/scroll/EclipsePhaseScrub";
import { PHASE_HUES } from "@/components/EclipseMark";
import PresenceCursors from "@/components/PresenceCursors";
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
  /** Responsive height classes for the visual slot; wins over `vh`. */
  vhClass?: string;
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
  /** Show multiplayer agent cursors over this section (AI Harness). */
  presence?: boolean;
  /** Full-bleed stage between the title and the grid — the section's lead image. */
  hero?: React.ReactNode;
  /**
   * A section-specific body. When present it replaces the generic feature grid.
   * Used sparingly where the content has a real hierarchy rather than a set of
   * equal feature cards (Content OS: sticky intent lead + narrow story rail).
   */
  body?: React.ReactNode;
}

/** Column-based drift so grid cards parallax at slightly different rates. */
const DRIFT = [0, 26, -20];

/**
 * Grid span per `span` value. The grid is 1 / 2 / 3 columns, so a 3-span tile
 * has to take the full row at each breakpoint, not just at `lg`.
 */
const SPANS: Record<number, string | undefined> = {
  1: undefined,
  2: "sm:col-span-2",
  3: "sm:col-span-2 lg:col-span-3",
};

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
  presence,
  hero,
  body,
}: SectionData) {
  const no = String(index).padStart(2, "0");
  const [hue] = PHASE_HUES[phase] ?? PHASE_HUES[0]!;

  const cards = features.map((f, i) => (
    <RevealItem key={f.title} className={SPANS[f.span ?? 1]}>
      <ParallaxItem className="h-full" drift={DRIFT[i % 3] ?? 0}>
        <FeatureCard
          title={f.title}
          description={f.desc}
          visualHeight={f.vh ?? 190}
          visualHeightClass={f.vhClass}
          visualBg={f.bg}
          visual={
            f.node ??
            (f.badge ? <Badge tone={f.badgeTone ?? "accent"}>{f.badge}</Badge> : undefined)
          }
        />
      </ParallaxItem>
    </RevealItem>
  ));
  return (
    <Scene
      id={id}
      className="relative mx-auto max-w-[1200px] px-5 pt-[90px] md:pt-[140px]"
    >
      {presence && <PresenceCursors />}
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

      {hero && <div className="mt-10 md:mt-14">{hero}</div>}

      {body ?? (
        <RevealGroup className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 md:mt-16 lg:grid-cols-3">
          {cards}
        </RevealGroup>
      )}
    </Scene>
  );
}
