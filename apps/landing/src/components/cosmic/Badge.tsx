const tones = {
  neutral: "rgba(244, 236, 255, 0.72)",
  accent: "#b06bff",
  violet: "#9b5cff",
  blue: "#29d8e6",
  green: "#34e0b4",
} as const;

export type BadgeTone = keyof typeof tones;

interface BadgeProps {
  children: React.ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
}

/** Glass pill chip with a glowing tone dot. */
export default function Badge({ children, tone = "neutral", dot = true }: BadgeProps) {
  const c = tones[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full ring-glass"
      style={{
        height: 24,
        padding: "0 10px",
        background: "var(--color-glass)",
        font: "500 10px/16px var(--font-mono-stack, monospace)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--color-text-secondary)",
      }}
    >
      {dot && (
        <span
          className="rounded-full"
          style={{ width: 6, height: 6, background: c, boxShadow: `0 0 8px ${c}` }}
        />
      )}
      {children}
    </span>
  );
}
