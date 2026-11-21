# @lumibase/portal

Embeddable member Portal for LumiBase (epic #672): sign-up / sign-in by magic link, account view,
newsletter toggles and tier switch. Works as a script tag, a `<lumi-portal>` custom element, or a
React component. See [Memberships & newsletters](../../docs/en/features/memberships.md).

```html
<script src="https://unpkg.com/@lumibase/portal/dist/portal.min.js" defer></script>
<lumi-portal api="https://cms.example.com" site="site_1" locale="vi"></lumi-portal>
```

```tsx
import { LumiPortal } from '@lumibase/portal/react';
<LumiPortal url="https://cms.example.com" siteId="site_1" />;
```

Missing or malformed options render nothing; server strings are always set as text. Theme with
`--lumi-portal-*` CSS custom properties.
