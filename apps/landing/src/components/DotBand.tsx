import DotField from "@/components/DotField";

/**
 * DotBand — full-width halftone strip with a mono caption row. The dot matrix
 * is the recurring brand motif; the band gives it a home mid-page, breaking the
 * run of product sections the way a printed rule breaks a magazine spread.
 */
export default function DotBand({ items }: { items: string[] }) {
  return (
    <section className="relative my-[10vh] overflow-hidden py-14">
      <hr className="rule-dashed absolute inset-x-0 top-0" />
      <hr className="rule-dashed absolute inset-x-0 bottom-0" />

      {/* Masked so the field dissolves toward both edges instead of ending on a
          hard vertical line. */}
      <DotField
        frequency={3}
        speed={3}
        cellSize={22}
        gamma={7}
        paletteBias={-3}
        style={{
          opacity: 0.8,
          maskImage:
            "linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent)",
          WebkitMaskImage:
            "linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent)",
        }}
      />

      <div className="relative mx-auto flex max-w-[1200px] flex-wrap items-center justify-center gap-x-8 gap-y-3 px-5">
        {items.map((item, i) => (
          <span key={item} className="flex items-center gap-8">
            {/* Blurred chip so the caption stays legible over the dot grid
                instead of interleaving with it. */}
            <span
              className="label-mono rounded-full px-3 py-1.5"
              style={{
                letterSpacing: "0.2em",
                background: "rgba(7, 6, 12, 0.62)",
                backdropFilter: "blur(6px)",
                WebkitBackdropFilter: "blur(6px)",
                color: "var(--foreground)",
              }}
            >
              {item}
            </span>
            {i < items.length - 1 && (
              <span
                aria-hidden
                className="hidden h-1 w-1 rounded-full sm:block"
                style={{ background: "var(--color-accent)" }}
              />
            )}
          </span>
        ))}
      </div>
    </section>
  );
}
