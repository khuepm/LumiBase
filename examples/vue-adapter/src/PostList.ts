// An SFC would read the same; a render function keeps the smoke check on plain `tsc`.
import { computed, defineComponent, h, ref } from 'vue';
import { usePresence } from '@lumibase/vue';

import { useItem, useItems } from './lumi';

export const PostList = defineComponent({
  name: 'PostList',
  setup() {
    const limit = ref(10);
    // Re-fetches when `limit` changes and, while mounted, on realtime events.
    const { items, pending, error } = useItems('posts', () => ({ limit: limit.value, sort: ['-created_at'] }), {
      live: true,
    });
    const titles = computed(() => items.value.map((post) => post.data.title ?? '(untitled)'));

    return () =>
      h('section', [
        pending.value ? h('p', 'Loading…') : null,
        error.value ? h('p', { role: 'alert' }, String(error.value)) : null,
        h('ul', titles.value.map((title) => h('li', title))),
        h('button', { onClick: () => (limit.value += 10) }, 'More'),
      ]);
  },
});

export const PostDetail = defineComponent({
  name: 'PostDetail',
  props: { id: { type: String, required: true } },
  setup(props) {
    const { data } = useItem('posts', () => props.id, { live: true });
    // Announce who is looking at this post; cleared on unmount.
    const { users } = usePresence(() => ({ collection: 'posts', itemId: props.id }));

    return () =>
      h('article', [
        h('h1', data.value?.data.title ?? ''),
        h('p', `${users.value.length} viewing`),
        h('div', data.value?.data.body ?? ''),
      ]);
  },
});
