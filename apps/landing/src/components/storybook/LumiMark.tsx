import { useId } from "react";

/**
 * Lumi as a flat mark: the header logo, and the stand-in for the 3D scene when
 * WebGL is unavailable. Pure SVG, so it renders on the server and without JS.
 */
export default function LumiMark({
  size = 32,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Omit for a decorative mark; pass a name to expose it to assistive tech. */
  title?: string;
}) {
  const id = useId();
  // A scalloped outline reads as fluff at any size.
  const tufts = 22;
  let outline = "";
  for (let i = 0; i <= tufts; i++) {
    const a = (i / tufts) * Math.PI * 2;
    const mid = ((i - 0.5) / tufts) * Math.PI * 2;
    const x = (50 + Math.cos(a) * 31).toFixed(2);
    const y = (56 + Math.sin(a) * 31).toFixed(2);
    if (i === 0) {
      outline += `M${x} ${y}`;
    } else {
      const cx = (50 + Math.cos(mid) * 37.5).toFixed(2);
      const cy = (56 + Math.sin(mid) * 37.5).toFixed(2);
      outline += `Q${cx} ${cy} ${x} ${y}`;
    }
  }
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <radialGradient id={`${id}-coat`} cx="42%" cy="34%" r="75%">
          <stop offset="0" stopColor="#fffaf0" />
          <stop offset="0.6" stopColor="#f3e5cd" />
          <stop offset="1" stopColor="#d9c3a2" />
        </radialGradient>
        <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#fff6d8" />
          <stop offset="0.35" stopColor="#ffc24a" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffb02e" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M53 27 C52 18 56 11 64 9" fill="none" stroke="#f0b23c" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="64" cy="9" r="9" fill={`url(#${id}-glow)`} />
      <circle cx="64" cy="9" r="3.6" fill="#ffd77a" />
      <path d={`${outline}Z`} fill={`url(#${id}-coat)`} />
      <ellipse cx="31" cy="64" rx="6.5" ry="4.6" fill="#ff9fb6" opacity="0.75" />
      <ellipse cx="69" cy="64" rx="6.5" ry="4.6" fill="#ff9fb6" opacity="0.75" />
      <ellipse cx="39.5" cy="54" rx="3.4" ry="4.2" fill="#15100f" />
      <ellipse cx="60.5" cy="54" rx="3.4" ry="4.2" fill="#15100f" />
      <circle cx="38.4" cy="52.4" r="1.2" fill="#fff" />
      <circle cx="59.4" cy="52.4" r="1.2" fill="#fff" />
      <path d="M45 62.5 Q50 67.5 55 62.5" fill="none" stroke="#4a2c1a" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
