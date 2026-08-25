import GlitterWarp from "@/components/GlitterWarp";

/**
 * The page backdrop. Deliberately restrained: a near-black field, one warp
 * starfield doing all the work, and a vignette that pulls focus to the centre
 * where the eclipse sits. The previous version washed the page in four
 * competing colour blobs plus a rotating aurora — the colour now comes from
 * the starfield's own palette and the eclipse corona, not from the floor.
 */
export default function CosmicBackground() {
  return (
    <div className="cosmic-bg" aria-hidden>
      <GlitterWarp
        particleCount={440}
        color1="#ffffff"
        color2="#b06bff"
        color3="#29d8e6"
        speed={3}
        density={100}
        starSize={8}
        focalDepth={13}
        brightness={90}
        glitterIntensity={3}
        trailAmount={90}
      />
      <div className="cosmic-vignette" />
    </div>
  );
}
