<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>My LumiBase site</title>
</svelte:head>

{#if !data.configured}
  <h1>Almost there</h1>
  <p>This site is not connected to a LumiBase instance yet.</p>
  <p>Missing: {#each data.missing as name}<code>{name}</code> {/each}</p>
  <ol>
    <li>
      <code>cp .env.example .env</code> and fill in the CMS URL, site id and a
      <em>publishable</em> key (<code>lbk_pub_…</code>).
    </li>
    <li>Restart <code>npm run dev</code> — or set the same variables on your Cloudflare Pages project.</li>
  </ol>
{:else}
  <h1>My LumiBase site</h1>
  <p class="muted">Rendered by SvelteKit on Cloudflare Pages from LumiBase content.</p>
  {#if data.posts.length === 0}
    <p>No published posts yet. Publish one in Studio and reload.</p>
  {:else}
    <ul class="posts">
      {#each data.posts as post (post.id)}
        <li>
          <h2>
            {#if post.data.slug}
              <a href="/posts/{post.data.slug}">{post.data.title ?? 'Untitled'}</a>
            {:else}
              {post.data.title ?? 'Untitled'}
            {/if}
          </h2>
          {#if data.preview && post.status !== 'published'}
            <p class="muted">Status: {post.status}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .posts {
    list-style: none;
    padding: 0;
  }
  .posts li + li {
    margin-top: 1.5rem;
  }
  .muted {
    opacity: 0.7;
  }
</style>
