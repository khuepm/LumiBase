import { ACCENT_COLORS, planetGradient, type Accent } from "@/lib/design";

interface PlanetIconProps {
  accent: Accent;
  /** Square size in px. */
  size?: number;
  /** Border radius in px. */
  radius?: number;
  /** Glow blur radius in px (0 disables). */
  glow?: number;
  className?: string;
}

/** Planet-style app icon — radial gradient sphere with a soft accent glow. */
export default function PlanetIcon({
  accent,
  size = 46,
  radius = 14,
  glow = 30,
  className = "",
}: PlanetIconProps) {
  const colors = ACCENT_COLORS[accent];
  return (
    <div
      aria-hidden
      className={`flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: planetGradient(accent),
        boxShadow: glow > 0 ? `0 0 ${glow}px ${colors.glow}` : undefined,
      }}
    />
  );
}
