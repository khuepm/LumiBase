/**
 * React wrapper: `<LumiPortal url siteId locale … />`. Mounts the same widget
 * into a host `<div>` (client only; renders an empty div on the server).
 */

import { createElement, useEffect, useRef, type CSSProperties } from 'react';
import { mountPortal, type PortalOptions } from './mount';

export interface LumiPortalProps extends PortalOptions {
  className?: string;
  style?: CSSProperties;
}

export function LumiPortal(props: LumiPortalProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { className, style, ...options } = props;
  const key = JSON.stringify({ ...options, fetcher: undefined, onSignedIn: undefined });
  useEffect(() => {
    const handle = mountPortal(ref.current, options);
    return () => handle.destroy();
    // Remount when serialisable options change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return createElement('div', { ref, className, style, 'data-lumi-portal-host': '' });
}
