<script lang="ts">
  import type { Snippet } from 'svelte';
  import VisualEditing from '#lib/components/VisualEditing.svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<svelte:head>
  {#if data.preview}
    <meta name="robots" content="noindex, nofollow" />
  {/if}
</svelte:head>

{#if data.preview}
  <p class="preview-banner">
    Draft preview — unpublished content is visible.
    <a href="/api/preview/exit" data-sveltekit-reload>Exit preview</a>
  </p>
{/if}

<main>
  {@render children()}
</main>

{#if data.preview}
  <VisualEditing />
{/if}

<style>
  :global(:root) {
    color-scheme: light dark;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    line-height: 1.6;
  }
  :global(body) {
    margin: 0;
  }
  main {
    max-width: 44rem;
    margin: 0 auto;
    padding: 3rem 1.25rem;
  }
  .preview-banner {
    margin: 0;
    padding: 0.5rem 1rem;
    text-align: center;
    background: #fde68a;
    color: #451a03;
  }
</style>
