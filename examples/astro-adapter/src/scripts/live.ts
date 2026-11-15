// Imported from a client `<script>` in a page: reload when posts change.
// Cleans itself up on navigation (`astro:before-swap`) and `pagehide`.
import { RealtimeClient } from '@lumibase/sdk';
import { watchCollection } from '@lumibase/astro/client';

// A read-only delivery token: this file ships to the browser.
const realtime = new RealtimeClient({
  baseUrl: 'http://127.0.0.1:1989',
  siteId: 'site_demo',
  token: 'public-delivery-token',
});

export const stop = watchCollection(realtime, 'posts', (event) => {
  if (event.action !== 'delete') location.reload();
});
