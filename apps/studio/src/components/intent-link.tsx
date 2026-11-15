/**
 * In-app link to a Studio intent (issue #759). Builds the URL with the shared
 * contract builder so in-app links and links minted by the CMS (email, chat,
 * push) are the same URL. Navigates client-side via `href` (not `search`):
 * TanStack would JSON-quote values such as `id=123`, which the intent route
 * reads raw. Falls back to a plain route link when the target cannot be
 * expressed as a valid intent (e.g. a legacy id outside the contract).
 */
import { Link, useNavigate } from '@tanstack/react-router';
import type { MouseEvent, ReactNode } from 'react';
import { buildStudioIntentPath, type StudioIntentInput } from '@lumibase/contracts/intents';

export function studioIntentHref(adminBase: string, input: StudioIntentInput): string | null {
  try {
    return `${adminBase}${buildStudioIntentPath(input)}`;
  } catch {
    return null;
  }
}

export function IntentLink({
  adminBase,
  intent,
  fallbackTo,
  className,
  children,
}: {
  adminBase: string;
  intent: StudioIntentInput;
  fallbackTo: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const href = studioIntentHref(adminBase, intent);
  if (!href) {
    return (
      <Link to={fallbackTo as never} className={className}>
        {children}
      </Link>
    );
  }
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigate({ href });
  };
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
