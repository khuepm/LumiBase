/**
 * Small inline visualisations rendered inside FeatureCard visual slots.
 * Pure markup — no client JS.
 */

const sans = "var(--font-sans, inherit)";

export function RunsViz() {
  const runs = [
    { s: "✓", c: "var(--color-green)", t: "Draft 12 release notes", m: "L2 · auto" },
    { s: "⏸", c: "var(--color-violet)", t: "Rewrite pricing page", m: "awaiting approval" },
    { s: "✓", c: "var(--color-green)", t: "Translate docs → vi + en", m: "L3 · veto window" },
    { s: "•", c: "var(--color-blue)", t: "Reconcile SEO titles", m: "running" },
  ];
  return (
    <div className="flex w-full flex-col gap-2 p-[22px]">
      {runs.map((r) => (
        <div
          key={r.t}
          className="ring-glass flex items-center gap-3 rounded-xl px-3.5 py-2.5"
          style={{ background: "var(--color-surface-3)" }}
        >
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-cream"
            style={{ background: r.c, font: `700 11px ${sans}` }}
          >
            {r.s}
          </span>
          <span className="flex-1 text-cream" style={{ font: `600 13px ${sans}` }}>
            {r.t}
          </span>
          <span style={{ font: `500 11px ${sans}`, color: "var(--color-text-muted)" }}>
            {r.m}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProvenanceViz() {
  const rows: Array<[string, string]> = [
    ["agent:writer-2", "drafted body · run #482"],
    ["human:mai", "approved · constitution ✓"],
    ["agent:translator", "localized vi → en"],
  ];
  return (
    <div className="flex w-full flex-col gap-2 p-5">
      {rows.map(([who, what], i) => (
        <div
          key={who}
          className="flex items-center gap-2.5"
          style={{ font: `500 12px ${sans}`, color: "var(--color-text-secondary)" }}
        >
          <span
            className="h-[7px] w-[7px] rounded-full"
            style={{ background: i === 1 ? "var(--color-blue)" : "var(--color-violet)" }}
          />
          <code className="text-cream" style={{ font: "600 12px var(--font-mono, monospace)" }}>
            {who}
          </code>
          <span>{what}</span>
        </div>
      ))}
    </div>
  );
}

export function IntentViz() {
  return (
    <div className="w-full max-w-[480px] p-6">
      <div
        className="ring-glass flex items-center gap-2.5 rounded-xl px-3.5"
        style={{ height: 44, background: "var(--color-surface-sunken)" }}
      >
        <span
          className="min-w-0 flex-1 truncate text-left"
          style={{ font: `500 14px ${sans}`, color: "var(--foreground)" }}
        >
          Every product: ≥1 image · 50–200 words · vi+en
        </span>
        <span className="btn-pill btn-solid btn-sm shrink-0">
          <span>Set intent</span>
        </span>
      </div>
      <div className="mt-3.5 flex items-center gap-2.5">
        <span style={{ font: `500 12px ${sans}`, color: "var(--color-text-muted)" }}>
          desired
        </span>
        <div
          className="relative h-1.5 flex-1 rounded-[3px]"
          style={{ background: "var(--color-surface-4)" }}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-[3px]"
            style={{ right: "18%", background: "var(--color-blue)" }}
          />
        </div>
        <span className="text-cream" style={{ font: `600 12px ${sans}` }}>
          82% converged
        </span>
      </div>
    </div>
  );
}

export function NewsroomViz() {
  const agents: Array<[string, string]> = [
    ["✍", "Writer"],
    ["✦", "Reviewer"],
    ["⟳", "Translator"],
    ["◎", "SEO"],
  ];
  return (
    <div className="grid w-full grid-cols-2 gap-2.5 p-5">
      {agents.map(([icon, name]) => (
        <div
          key={name}
          className="ring-glass flex items-center gap-2.5 rounded-xl px-3 py-2.5"
          style={{ background: "var(--color-surface-3)" }}
        >
          <span
            className="flex h-[26px] w-[26px] items-center justify-center rounded-lg text-sm text-cream"
            style={{ background: "linear-gradient(180deg,#2c1c0e,#150c05)" }}
          >
            {icon}
          </span>
          <span className="text-cream" style={{ font: `600 12px ${sans}` }}>
            {name}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SchemaViz() {
  const fields: Array<[string, string]> = [
    ["title", "string"],
    ["slug", "string"],
    ["author", "m2o → users"],
    ["body", "richtext · encrypted"],
  ];
  return (
    <div className="flex w-full flex-col gap-[7px] px-[18px] py-[18px]">
      {fields.map(([name, type]) => (
        <div
          key={name}
          className="ring-glass flex items-center justify-between rounded-[10px] px-3 py-2"
          style={{ background: "var(--color-surface-3)" }}
        >
          <span className="text-cream" style={{ font: `600 12px ${sans}` }}>
            {name}
          </span>
          <span
            style={{
              font: "500 11px var(--font-mono, monospace)",
              color: "var(--color-text-muted)",
            }}
          >
            {type}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CodeViz() {
  const kw = { color: "var(--color-violet)" };
  const str = { color: "var(--color-green)" };
  return (
    <div className="w-full p-[22px]">
      <pre
        className="ring-glass m-0 overflow-hidden rounded-xl p-4"
        style={{
          background: "var(--color-surface-sunken)",
          font: "500 12px/1.7 var(--font-mono, monospace)",
          color: "var(--color-text-secondary)",
        }}
      >
        <span style={kw}>import</span> {"{ createClient }"} <span style={kw}>from</span>{" "}
        <span style={str}>&apos;@lumibase/sdk&apos;</span>
        {"\n"}
        <span style={kw}>const</span> db = createClient{"<Schema>"}(url)
        {"\n"}
        <span style={kw}>const</span> posts = <span style={kw}>await</span> db.items(
        <span style={str}>&apos;posts&apos;</span>).read()
      </pre>
    </div>
  );
}

export function McpViz() {
  return (
    <div className="flex w-full flex-col items-center gap-3 p-6">
      <div
        className="flex items-center justify-center rounded-[18px] text-cream"
        style={{
          width: 70,
          height: 70,
          background: "linear-gradient(180deg,#2c1c0e,#150c05)",
          boxShadow: "var(--ring-glass), 0 0 50px rgba(255,160,0,0.35)",
          font: `700 26px ${sans}`,
        }}
      >
        ⌘
      </div>
      <span style={{ font: `500 12px ${sans}`, color: "var(--color-text-muted)" }}>
        @lumibase/mcp-server
      </span>
    </div>
  );
}

export function CdcViz() {
  const nodes = ["Postgres", "CDC", "ClickHouse"];
  return (
    <div className="flex w-full items-center justify-center gap-2.5 p-5">
      {nodes.map((n, i) => (
        <span key={n} className="flex items-center gap-2.5">
          <span
            className="ring-glass rounded-[10px] px-3 py-2 text-cream"
            style={{ background: "var(--color-surface-3)", font: `600 12px ${sans}` }}
          >
            {n}
          </span>
          {i < nodes.length - 1 && (
            <span style={{ color: "var(--color-blue)", fontSize: 16 }}>→</span>
          )}
        </span>
      ))}
    </div>
  );
}
