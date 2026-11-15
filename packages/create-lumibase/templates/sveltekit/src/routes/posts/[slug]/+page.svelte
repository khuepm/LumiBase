<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const title = $derived(data.post.data.title ?? 'Untitled');
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<p><a href="/">← All posts</a></p>
<article>
  <h1>{title}</h1>
  <!-- Rendered as text, not {@html}: CMS content is untrusted input until you
       add a sanitiser you trust. -->
  {#if data.post.data.body}
    <p>{data.post.data.body}</p>
  {/if}
</article>
