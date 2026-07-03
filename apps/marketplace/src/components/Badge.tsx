import { ACCENT_COLORS, type Accent } from "@/lib/design";

interface BadgeProps {
  children: React.ReactNode;
  tone?: Accent;
  dot?: boolean;
  className?: string;
}

/** Category chip — glass pill with a glowing tone dot. */
export default function Badge({
  children,
  tone = "neutral",
  dot = true,
  className = "",
}: BadgeProps) {
  const c = tone === "neutral" ? "rgb(189,189,192)" : ACCENT_COLORS[tone].accent;
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-glass px-2.5 text-[11px] font-semibold leading-4 text-txt-secondary ring-glass ${className}`}
    >
      {dot && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: c, boxShadow: `0 0 8px ${c}` }}
        />
      )}
      {children}
    </span>
  );
}
