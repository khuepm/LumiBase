/**
 * Animated cosmic backdrop — a fixed layer of slowly drifting aurora clouds,
 * a very slow rotating aurora sheen, and an occasional shooting star. Pure
 * CSS (see globals.css); no client JS. Sits behind all content and the
 * eclipse stage. Freezes gracefully under prefers-reduced-motion.
 */
export default function CosmicBackground() {
  return (
    <div className="cosmic-bg" aria-hidden>
      <div className="cosmic-aurora" />
      <div className="cosmic-blob cosmic-blob-1" />
      <div className="cosmic-blob cosmic-blob-2" />
      <div className="cosmic-blob cosmic-blob-3" />
      <div className="cosmic-blob cosmic-blob-4" />
      <div className="cosmic-blob cosmic-blob-5" />
      <div className="cosmic-blob cosmic-blob-6" />
      <div className="cosmic-shooting-star" />
    </div>
  );
}
