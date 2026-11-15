import { useEffect } from 'react';

/**
 * Jump-to-field deep links (#692). A link to the item editor whose hash is
 * `#field=<name>` (the release validation summary builds these) scrolls the
 * field into view, focuses its first control and highlights it briefly.
 */
export function fieldFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = new URLSearchParams(raw).get('field');
  return value && value.length > 0 ? value : null;
}

export function focusField(root: ParentNode, name: string): boolean {
  const el = root.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`);
  if (!el) return false;
  el.scrollIntoView?.({ block: 'center' });
  const control = el.querySelector<HTMLElement>('input, textarea, select, [contenteditable="true"], button');
  control?.focus({ preventScroll: true });
  el.classList.add('ring-2', 'ring-destructive', 'rounded-md');
  setTimeout(() => el.classList.remove('ring-2', 'ring-destructive', 'rounded-md'), 2500);
  return true;
}

/** Focus the field named in `location.hash` once the form has rendered `ready` fields. */
export function useFocusFieldFromHash(ready: number): void {
  useEffect(() => {
    if (typeof window === 'undefined' || ready === 0) return;
    const run = () => {
      const name = fieldFromHash(window.location.hash);
      if (name) focusField(document, name);
    };
    // Let the form paint first.
    const t = setTimeout(run, 0);
    window.addEventListener('hashchange', run);
    return () => {
      clearTimeout(t);
      window.removeEventListener('hashchange', run);
    };
  }, [ready]);
}
