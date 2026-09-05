interface FeatureCardProps {
  title: string;
  description: string;
  visual?: React.ReactNode;
  visualHeight?: number;
  /**
   * Tailwind height classes for the visual slot, for visuals whose natural
   * height changes with the breakpoint (a two-column panel that stacks on
   * mobile needs more room there, not less). Wins over `visualHeight`.
   */
  visualHeightClass?: string;
  visualBg?: string;
  glow?: "none" | "violet" | "blue";
}

/**
 * Dark feature panel — title + description on top, a visual area pinned to
 * the bottom. The building block of every product section.
 */
export default function FeatureCard({
  title,
  description,
  visual,
  visualHeight = 190,
  visualHeightClass,
  visualBg,
  glow = "none",
}: FeatureCardProps) {
  const glows = {
    none: "",
    violet: ", var(--glow-violet)",
    blue: ", var(--glow-blue)",
  };
  return (
    <div
      className="card-cosmic flex h-full flex-col"
      style={{ boxShadow: `var(--ring-glass)${glows[glow]}` }}
    >
      <div className="p-6">
        <div
          style={{
            font: "400 21px/29px var(--font-display-stack)",
            letterSpacing: "-0.1px",
            color: "var(--foreground)",
          }}
        >
          {title}
        </div>
        <div
          className="mt-2"
          style={{
            font: "500 14px/22px var(--font-sans, inherit)",
            color: "var(--color-text-secondary)",
          }}
        >
          {description}
        </div>
      </div>
      {visual && (
        <div
          className={`relative mt-auto overflow-hidden ${visualHeightClass ?? ""}`}
          style={visualHeightClass ? undefined : { height: visualHeight }}
        >
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: visualBg ?? "transparent" }}
          >
            {visual}
          </div>
        </div>
      )}
    </div>
  );
}
