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
          <stop offset="52%" stopColor="#ffb020" stopOpacity="0.9" />
          <stop offset="66%" stopColor="#ff4d8d" stopOpacity="0.55" />
          <stop offset="80%" stopColor="#9b5cff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#29d8e6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="em-moon" cx="38%" cy="34%" r="80%">
          <stop offset="0%" stopColor="#251a30" />
          <stop offset="60%" stopColor="#120b1c" />
          <stop offset="100%" stopColor="#0b0713" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#em-corona)" />
      <circle cx="24" cy="24" r="15.5" stroke="#ffb020" strokeWidth="1.6" />
      <circle cx="24" cy="24" r="15.5" stroke="#c4a8ff" strokeWidth="0.5" opacity="0.85" />
      <circle cx="35.2" cy="13.6" r="1.7" fill="#ffffff" />
      <circle cx="35.2" cy="13.6" r="3.4" fill="#c4a8ff" opacity="0.3" />
      <circle cx="24" cy="24" r="15" fill="url(#em-moon)" />
      <g transform="translate(24 25) rotate(-16)">
        <path d="M -4.6 0 L -10 0" stroke="#29d8e6" strokeWidth="0.7" strokeLinecap="round" opacity="0.55" />
        <path d="M -4.6 0 L -7.4 0" stroke="#b06bff" strokeWidth="1" strokeLinecap="round" opacity="0.95" />
        <path d="M 5.2 0 C 4.2 -1.7 1.4 -2 -2.4 -1.5 L -4.4 0 L -2.4 1.5 C 1.4 2 4.2 1.7 5.2 0 Z" fill="#f4ecff" />
        <path d="M -1.4 -1.4 L -3.4 -3 L -4.2 -0.8 Z" fill="#c4a8ff" />
        <path d="M -1.4 1.4 L -3.4 3 L -4.2 0.8 Z" fill="#c4a8ff" />
        <circle cx="1.6" cy="0" r="0.7" fill="#0b0713" />
      </g>
    </svg>
  );
}

/** Moon offset per phase — 0 = first contact … 3 = totality. */
const PHASE_OFFSET = [11, 7, 3.5, 0];

/** Each phase carries its own mystical hue [sun disc, corona/glow]. */
export const PHASE_HUES: Array<[string, string]> = [
  ["#ffb020", "#ff6a1a"], // 0 · gold
  ["#ff4d8d", "#d61f9f"], // 1 · rose → magenta
  ["#b06bff", "#9b5cff"], // 2 · violet
  ["#29d8e6", "#34e0b4"], // 3 · cyan → teal (totality corona)
];

export function EclipsePhase({ phase, size = 72 }: { phase: 0 | 1 | 2 | 3; size?: number }) {
  const id = `ep-p${phase}`;
  const dx = PHASE_OFFSET[phase] ?? 0;
  const total = phase === 3;
  const [disc, glow] = PHASE_HUES[phase] ?? PHASE_HUES[0]!;
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-g`} cx="50%" cy="50%" r="50%">
          <stop offset="48%" stopColor={disc} stopOpacity={total ? 0.85 : 0.6} />
          <stop offset="72%" stopColor={glow} stopOpacity={total ? 0.42 : 0.26} />
          <stop offset="100%" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-d`} cx="42%" cy="38%" r="70%">
          <stop offset="0%" stopColor={disc} />
          <stop offset="100%" stopColor={glow} />
        </radialGradient>
        <clipPath id={`${id}-c`}>
          <circle cx="36" cy="36" r="21" />
        </clipPath>
      </defs>
      <circle cx="36" cy="36" r="34" fill={`url(#${id}-g)`} />
      {/* Sun disc */}
      <circle cx="36" cy="36" r="20" fill={`url(#${id}-d)`} />
      <circle cx="36" cy="36" r="20" stroke="#f4ecff" strokeWidth="0.8" opacity="0.7" />
      {/* Moon bite, clipped to the sun */}
      <g clipPath={`url(#${id}-c)`}>
        <circle cx={36 + dx} cy={36 - dx * 0.35} r="19.4" fill="#0b0713" />
      </g>
      {total && (
        <>
          <circle cx="36" cy="36" r="20" stroke={disc} strokeWidth="1.8" />
          <circle cx="49.5" cy="23.5" r="1.9" fill="#ffffff" />
          <circle cx="49.5" cy="23.5" r="4" fill="#c4a8ff" opacity="0.28" />
        </>
      )}
    </svg>
  );
}
