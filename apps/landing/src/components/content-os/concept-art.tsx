/**
 * Illustrations for the three Content OS concept cards.
 *
 * Static SVG, not animation. Each is a diagram of the idea its card names,
 * drawn dark so it sits in the page rather than on top of it:
 *
 *   LoopArt  — an item leaves the declared orbit; an arc brings it back.
 *   GateArt  — three items reach the publish seam; one is turned away.
 *   RelayArt — work moves writer → reviewer → translator, and the path back to
 *              itself is struck out (no self-approval).
 *
 * They replaced looping micro-animations that drew the eye without paying it
 * back. A thumbnail that holds still can be read in the half second someone
 * gives it, and re-read on the way back up the page.
 *
 * 320×180 viewBox, scaled by the card. Gradient/marker ids are prefixed per
 * illustration so several can share a document without colliding.
 */

const VIOLET = "#b06bff";
const MAGENTA = "#d61f9f";
const TEAL = "#29d8e6";
const GOLD = "#ffb020";
const CREAM = "#f4ecff";
const INK = "#07060c";

const STARS: Array<[number, number, number, number]> = [
  [28, 34, 0.9, 0.5],
  [74, 18, 0.6, 0.35],
  [132, 46, 0.7, 0.3],
  [212, 26, 0.9, 0.45],
  [268, 62, 0.6, 0.3],
  [296, 132, 0.8, 0.4],
  [46, 138, 0.7, 0.32],
  [158, 158, 0.6, 0.28],
  [246, 152, 0.7, 0.3],
  [104, 118, 0.5, 0.25],
];

/** Shared backdrop: deep field, corner bloom, sparse stars. */
function Field({ id, bloom }: { id: string; bloom: string }) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bloom`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={bloom} stopOpacity="0.45" />
          <stop offset="60%" stopColor={bloom} stopOpacity="0.1" />
          <stop offset="100%" stopColor={bloom} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="320" height="180" fill={INK} />
      <ellipse cx="248" cy="22" rx="150" ry="110" fill={`url(#${id}-bloom)`} />
      <ellipse cx="42" cy="176" rx="130" ry="92" fill={`url(#${id}-bloom)`} opacity="0.45" />
      {STARS.map(([x, y, r, o]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={CREAM} opacity={o} />
      ))}
    </>
  );
}

function Arrow({ id, color }: { id: string; color: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="7"
      refY="5"
      markerWidth="5"
      markerHeight="5"
      orient="auto"
    >
      <path d="M 0 1 L 8 5 L 0 9 z" fill={color} />
    </marker>
  );
}

export function LoopArt() {
  const id = "ca-loop";
  return (
    <svg
      viewBox="0 0 320 180"
      className="h-full w-full"
      role="img"
      aria-label="An item drifts off its declared orbit and an arc pulls it back"
    >
      <Field id={id} bloom={VIOLET} />
      <defs>
        <linearGradient id={`${id}-orbit`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={TEAL} stopOpacity="0.12" />
          <stop offset="50%" stopColor={TEAL} stopOpacity="0.7" />
          <stop offset="100%" stopColor={TEAL} stopOpacity="0.12" />
        </linearGradient>
        <Arrow id={`${id}-tip`} color={GOLD} />
      </defs>

      {/* The declared state, as a closed orbit. Everything on it has converged. */}
      <ellipse
        cx="150"
        cy="92"
        rx="98"
        ry="42"
        fill="none"
        stroke={`url(#${id}-orbit)`}
        strokeWidth="1.4"
      />
      <ellipse
        cx="150"
        cy="92"
        rx="98"
        ry="42"
        fill="none"
        stroke={TEAL}
        strokeWidth="0.4"
        opacity="0.22"
        strokeDasharray="2 7"
      />

      {[
        [58, 82],
        [116, 61],
        [196, 66],
        [238, 104],
        [122, 128],
      ].map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <circle cx={x} cy={y} r="6" fill={TEAL} opacity="0.14" />
          <circle cx={x} cy={y} r="2.6" fill={TEAL} />
        </g>
      ))}

      {/* The one that drifted: off the orbit, amber, on its way home. */}
      <path
        d="M 214 148 C 238 132 246 118 241 106"
        fill="none"
        stroke={GOLD}
        strokeWidth="1.3"
        strokeDasharray="4 4"
        opacity="0.9"
        markerEnd={`url(#${id}-tip)`}
      />
      <circle cx="214" cy="148" r="9" fill={GOLD} opacity="0.16" />
      <circle cx="214" cy="148" r="3.4" fill={GOLD} />
    </svg>
  );
}

export function GateArt() {
  const id = "ca-gate";
  const lanes: Array<{ y: number; blocked: boolean }> = [
    { y: 56, blocked: false },
    { y: 96, blocked: true },
    { y: 136, blocked: false },
  ];
  return (
    <svg
      viewBox="0 0 320 180"
      className="h-full w-full"
      role="img"
      aria-label="Three items reach the publish gate; the one that fails is turned back"
    >
      <Field id={id} bloom={MAGENTA} />
      <defs>
        <linearGradient id={`${id}-seam`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={VIOLET} stopOpacity="0" />
          <stop offset="18%" stopColor={VIOLET} stopOpacity="0.85" />
          <stop offset="82%" stopColor={MAGENTA} stopOpacity="0.85" />
          <stop offset="100%" stopColor={MAGENTA} stopOpacity="0" />
        </linearGradient>
        <Arrow id={`${id}-pass`} color={TEAL} />
        <Arrow id={`${id}-back`} color={GOLD} />
      </defs>

      {/* The gate: one luminous seam, notched like a hash. */}
      <rect x="186" y="22" width="2" height="136" fill={`url(#${id}-seam)`} />
      {[38, 54, 70, 86, 102, 118, 134].map((y) => (
        <rect key={y} x="181" y={y} width="12" height="1.2" fill={VIOLET} opacity="0.32" />
      ))}

      {lanes.map(({ y, blocked }) =>
        blocked ? (
          <g key={y}>
            <path d="M 62 96 L 170 96" fill="none" stroke={GOLD} strokeWidth="1.2" opacity="0.4" />
            <path
              d="M 172 96 C 150 96 130 110 106 110"
              fill="none"
              stroke={GOLD}
              strokeWidth="1.3"
              strokeDasharray="4 4"
              markerEnd={`url(#${id}-back)`}
            />
            <rect x="44" y="91" width="16" height="10" rx="2" fill={GOLD} opacity="0.4" />
            <rect x="164" y="90" width="12" height="12" rx="2" fill={GOLD} />
          </g>
        ) : (
          <g key={y}>
            <path
              d={`M 62 ${y} L 168 ${y}`}
              fill="none"
              stroke={TEAL}
              strokeWidth="1.2"
              opacity="0.45"
              markerEnd={`url(#${id}-pass)`}
            />
            <path
              d={`M 206 ${y} L 266 ${y}`}
              fill="none"
              stroke={TEAL}
              strokeWidth="1.2"
              opacity="0.75"
            />
            <rect x="44" y={y - 5} width="16" height="10" rx="2" fill={TEAL} opacity="0.32" />
            <rect x="268" y={y - 5} width="16" height="10" rx="2" fill={TEAL} />
          </g>
        ),
      )}
    </svg>
  );
}

export function RelayArt() {
  const id = "ca-relay";
  return (
    <svg
      viewBox="0 0 320 180"
      className="h-full w-full"
      role="img"
      aria-label="Work passes between three roles, and the path back to itself is struck out"
    >
      <Field id={id} bloom={TEAL} />
      <defs>
        <Arrow id={`${id}-tip`} color={CREAM} />
      </defs>

      {/* Handoffs, in order. */}
      <path
        d="M 78 110 C 102 80 128 66 144 63"
        fill="none"
        stroke={CREAM}
        strokeWidth="1.1"
        opacity="0.42"
        markerEnd={`url(#${id}-tip)`}
      />
      <path
        d="M 176 63 C 192 66 218 80 242 110"
        fill="none"
        stroke={CREAM}
        strokeWidth="1.1"
        opacity="0.42"
        markerEnd={`url(#${id}-tip)`}
      />

      {/* The one path that is refused: a role reviewing its own work. */}
      <path
        d="M 146 46 C 132 20 188 20 174 46"
        fill="none"
        stroke={GOLD}
        strokeWidth="1.1"
        opacity="0.45"
        strokeDasharray="3 3"
      />
      <g stroke={GOLD} strokeWidth="1.5" opacity="0.95" strokeLinecap="round">
        <path d="M 154 24 L 166 36" />
        <path d="M 166 24 L 154 36" />
      </g>

      {/* The roles. Distinguished by hue, not by a legend. */}
      {(
        [
          [62, 118, VIOLET],
          [160, 62, TEAL],
          [258, 118, MAGENTA],
        ] as Array<[number, number, string]>
      ).map(([x, y, hue]) => (
        <g key={`${x}-${y}`}>
          <circle cx={x} cy={y} r="17" fill={hue} opacity="0.1" />
          <circle cx={x} cy={y} r="11" fill={INK} stroke={hue} strokeWidth="1.2" />
          <circle cx={x} cy={y} r="3.2" fill={hue} />
        </g>
      ))}

      {/* The draft in flight between the first two. */}
      <circle cx="112" cy="86" r="2.4" fill={CREAM} opacity="0.85" />
    </svg>
  );
}
