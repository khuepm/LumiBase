/**
 * Brand marks for the eclipse identity.
 *
 * EclipseMark — the logo: sun corona at totality, dark moon disc, and a tiny
 * spaceship caught mid-transit. Inline SVG so it inherits crispness at any size.
 *
 * EclipsePhase — editorial section glyphs: the moon's progress across the sun
 * (first contact → totality), used as numbered-section markers.
 *
 * IDs are deterministic per variant; duplicate defs across instances are
 * identical, so the first-def-wins SVG rule keeps every instance correct.
 */

export function EclipseMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <defs>
        <radialGradient id="em-corona" cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="#ff8c00" stopOpacity="0.9" />
          <stop offset="72%" stopColor="#e6500a" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#e6500a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="em-moon" cx="38%" cy="34%" r="80%">
          <stop offset="0%" stopColor="#2c1c0e" />
          <stop offset="60%" stopColor="#150c05" />
          <stop offset="100%" stopColor="#100904" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#em-corona)" />
      <circle cx="24" cy="24" r="15.5" stroke="#ffa000" strokeWidth="1.6" />
      <circle cx="24" cy="24" r="15.5" stroke="#ffedd7" strokeWidth="0.5" opacity="0.85" />
      <circle cx="35.2" cy="13.6" r="1.7" fill="#ffedd7" />
      <circle cx="35.2" cy="13.6" r="3.4" fill="#ffedd7" opacity="0.25" />
      <circle cx="24" cy="24" r="15" fill="url(#em-moon)" />
      <g transform="translate(24 25) rotate(-16)">
        <path d="M -4.6 0 L -10 0" stroke="#ffedd7" strokeWidth="0.7" strokeLinecap="round" opacity="0.5" />
        <path d="M -4.6 0 L -7.4 0" stroke="#ffa000" strokeWidth="1" strokeLinecap="round" opacity="0.9" />
        <path d="M 5.2 0 C 4.2 -1.7 1.4 -2 -2.4 -1.5 L -4.4 0 L -2.4 1.5 C 1.4 2 4.2 1.7 5.2 0 Z" fill="#ffedd7" />
        <path d="M -1.4 -1.4 L -3.4 -3 L -4.2 -0.8 Z" fill="#f6e0c6" />
        <path d="M -1.4 1.4 L -3.4 3 L -4.2 0.8 Z" fill="#f6e0c6" />
        <circle cx="1.6" cy="0" r="0.7" fill="#100904" />
      </g>
    </svg>
  );
}

/** Moon offset per phase — 0 = first contact … 3 = totality. */
const PHASE_OFFSET = [11, 7, 3.5, 0];

export function EclipsePhase({ phase, size = 72 }: { phase: 0 | 1 | 2 | 3; size?: number }) {
  const id = `ep-p${phase}`;
  const dx = PHASE_OFFSET[phase] ?? 0;
  const total = phase === 3;
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-g`} cx="50%" cy="50%" r="50%">
          <stop offset="50%" stopColor="#ff8c00" stopOpacity={total ? 0.85 : 0.55} />
          <stop offset="74%" stopColor="#e6500a" stopOpacity={total ? 0.4 : 0.22} />
          <stop offset="100%" stopColor="#e6500a" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}-c`}>
          <circle cx="36" cy="36" r="21" />
        </clipPath>
      </defs>
      <circle cx="36" cy="36" r="34" fill={`url(#${id}-g)`} />
      {/* Sun disc */}
      <circle cx="36" cy="36" r="20" fill="#ffa000" />
      <circle cx="36" cy="36" r="20" stroke="#ffedd7" strokeWidth="0.8" opacity="0.7" />
      {/* Moon bite, clipped to the sun */}
      <g clipPath={`url(#${id}-c)`}>
        <circle cx={36 + dx} cy={36 - dx * 0.35} r="19.4" fill="#100904" />
      </g>
      {total && (
        <>
          <circle cx="36" cy="36" r="20" stroke="#ffa000" strokeWidth="1.8" />
          <circle cx="49.5" cy="23.5" r="1.9" fill="#ffedd7" />
          <circle cx="49.5" cy="23.5" r="4" fill="#ffedd7" opacity="0.22" />
        </>
      )}
    </svg>
  );
}
