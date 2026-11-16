/**
 * Widget styles. Theme through CSS custom properties on the host element,
 * e.g. `lumi-portal { --lumi-portal-accent: #0a7; --lumi-portal-radius: 0; }`.
 * Logical properties only, so RTL pages lay out correctly.
 */
export const PORTAL_CSS = `
:host, .lumi-portal {
  --lumi-portal-accent: #2f5bea;
  --lumi-portal-accent-text: #fff;
  --lumi-portal-text: inherit;
  --lumi-portal-muted: #667085;
  --lumi-portal-border: #d0d5dd;
  --lumi-portal-bg: transparent;
  --lumi-portal-radius: 8px;
  --lumi-portal-font: inherit;
  display: block;
  font-family: var(--lumi-portal-font);
  color: var(--lumi-portal-text);
}
.lumi-portal { background: var(--lumi-portal-bg); border: 1px solid var(--lumi-portal-border); border-radius: var(--lumi-portal-radius); padding-block: 1.25rem; padding-inline: 1.25rem; }
.lumi-portal[data-layout="inline"], .lumi-portal[data-layout="minimal"] { border: 0; padding-block: 0; padding-inline: 0; }
.lumi-portal h2 { margin-block: 0 0.5rem; font-size: 1.25rem; }
.lumi-portal p { margin-block: 0 0.75rem; color: var(--lumi-portal-muted); }
.lumi-portal form { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.lumi-portal input[type="email"], .lumi-portal input[type="text"] { flex: 1 1 12rem; min-inline-size: 0; padding-block: 0.5rem; padding-inline: 0.75rem; border: 1px solid var(--lumi-portal-border); border-radius: var(--lumi-portal-radius); font: inherit; }
.lumi-portal button { padding-block: 0.5rem; padding-inline: 1rem; border: 0; border-radius: var(--lumi-portal-radius); background: var(--lumi-portal-accent); color: var(--lumi-portal-accent-text); font: inherit; cursor: pointer; }
.lumi-portal button[data-variant="ghost"] { background: transparent; color: var(--lumi-portal-accent); padding-inline: 0; }
.lumi-portal button:disabled { opacity: 0.6; cursor: default; }
.lumi-portal ul { list-style: none; margin-block: 0 0.75rem; padding-inline-start: 0; }
.lumi-portal li { display: flex; align-items: center; gap: 0.5rem; padding-block: 0.25rem; }
.lumi-portal [role="status"] { margin-block-start: 0.5rem; }
.lumi-portal [data-tone="error"] { color: #b42318; }
`;
