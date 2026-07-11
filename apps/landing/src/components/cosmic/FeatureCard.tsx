interface FeatureCardProps {
  title: string;
  description: string;
  visual?: React.ReactNode;
  visualHeight?: number;
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
            font: "600 19px/26px var(--font-sans, inherit)",
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
          className="relative mt-auto overflow-hidden"
          style={{ height: visualHeight }}
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
