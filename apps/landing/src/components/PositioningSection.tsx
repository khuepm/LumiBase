import Scene from "@/components/scroll/Scene";
import WipeTitle from "@/components/scroll/WipeTitle";
import { RevealGroup, RevealItem } from "@/components/motion";

/**
 * Orientation scene — the first thing after the hero.
 *
 * The term "Content OS" means nothing on its own, so this section anchors it
 * to the thing every reader already knows: a CMS. One claim, then a row-by-row
 * contrast of what actually differs. No product analogy is borrowed here on
 * purpose — the four pillars below carry the mechanism; this only has to make
 * the category legible.
 */

const sans = "var(--font-sans, inherit)";

type Row = {
  /** What is being compared — the mono caption at the head of the row. */
  aspect: string;
  cms: string;
  os: string;
};

const ROWS: Row[] = [
  {
    aspect: "Unit of work",
    cms: "One operation at a time — a person opens an entry and edits it.",
    os: "A declared intent: the state your content should be in.",
  },
  {
    aspect: "Who operates",
    cms: "People. The tool waits to be told what to do.",
    os: "Governed agents pursue the goal; you set intent and taste.",
  },
  {
    aspect: "When it happens",
    cms: "When someone remembers, or when a ticket is filed.",
    os: "Continuously. Drift is detected and reconciled as it appears.",
  },
  {
    aspect: "Trust model",
    cms: "Role permissions — access is granted once, all or nothing.",
    os: "Autonomy is earned per capability, L0 shadow → L4 autopilot.",
  },
  {
    aspect: "Safety net",
    cms: "Undo, after the change is already live.",
    os: "Constitution, veto window and kill switch — before it publishes.",
  },
  {
    aspect: "What is recorded",
    cms: "An activity log: who clicked what, and when.",
    os: "Provenance: which agent, under which intent, on what evidence.",
  },
];

export default function PositioningSection() {
  return (
    <Scene
      id="what-is-a-content-os"
      className="relative mx-auto max-w-[1000px] px-5 pt-[90px] md:pt-[140px]"
    >
      <WipeTitle
        label="[ 00 / ORIENTATION ]"
        title={
          <>
            A CMS stores.
            <br />
            An OS operates.
          </>
        }
      >
        <p
          className="font-serif-body mx-auto mt-3.5 max-w-[560px]"
          style={{
            font: "400 19px/31px var(--font-serif-stack)",
            color: "var(--color-text-secondary)",
          }}
        >
          A CMS is where content sits and waits for someone to touch it. A
          Content OS is what runs it: you declare the state your content should
          be in, and a governed control loop keeps it there.
        </p>
      </WipeTitle>

      <RevealGroup className="card-cosmic mt-10 flex flex-col overflow-hidden p-0 md:mt-12">
        {/* Column heads — the row captions carry the same job on mobile. */}
        <div
          className="hidden md:grid md:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] md:gap-x-8 md:px-7 md:pb-4 md:pt-6"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <span />
          <span className="label-mono">Traditional CMS</span>
          <span className="label-mono label-mono-accent">
            LumiBase Content OS
          </span>
        </div>

        {ROWS.map((row, i) => (
          <RevealItem
            key={row.aspect}
            className="grid gap-x-8 gap-y-3 px-6 py-6 md:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)] md:px-7"
            style={
              i === 0 ? undefined : { borderTop: "1px solid var(--color-border)" }
            }
          >
            <span
              className="label-mono self-start"
              style={{ color: "var(--color-text-muted)" }}
            >
              {row.aspect}
            </span>

            <p
              className="m-0"
              style={{ font: `400 14px/23px ${sans}`, color: "var(--color-text-muted)" }}
            >
              <span className="label-mono mr-2 md:hidden">CMS</span>
              {row.cms}
            </p>

            <p
              className="m-0"
              style={{
                font: `500 14px/23px ${sans}`,
                color: "var(--color-text-secondary)",
              }}
            >
              <span className="label-mono label-mono-accent mr-2 md:hidden">
                Content OS
              </span>
              {row.os}
            </p>
          </RevealItem>
        ))}
      </RevealGroup>
    </Scene>
  );
}
