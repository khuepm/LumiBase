const tones = {
  neutral: "rgb(189, 189, 192)",
  violet: "rgb(123, 97, 255)",
  blue: "rgb(24, 160, 251)",
  green: "rgb(46, 196, 124)",
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
        font: "600 11px/16px var(--font-sans, inherit)",
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
