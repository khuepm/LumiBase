import { createApp, h } from 'vue';

import { lumiPlugin } from './lumi';
import { PostList } from './PostList';

createApp({ render: () => h(PostList) })
  .use(lumiPlugin)
  .mount('#app');
