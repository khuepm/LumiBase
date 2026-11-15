<!--
  Illustrative component (not part of the `tsc` smoke check — that covers the
  .ts modules it imports). Data arrives from `page.server.ts` and stays live.
-->
<script lang="ts">
  import { lumiPresence } from '@lumibase/svelte';
  import { livePosts, realtime } from '$lib/lumi';

  let { data } = $props();
  const posts = livePosts(data.posts);
</script>

<ul use:lumiPresence={{ realtime, collection: 'posts' }}>
  {#each $posts.data?.data ?? [] as post (post.id)}
    <li>{post.data.title}</li>
  {/each}
</ul>
