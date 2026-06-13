import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';

/**
 * LumiBase convention helpers.
 * - IDs: nanoid() for domain tables (never serial/auto-increment).
 * - Multi-tenancy: every domain table carries a `site_id`.
 */
const id = () =>
  text('id')
    .$defaultFn(() => nanoid())
    .primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const posts = pgTable(
  'posts',
  {
    id: id(),
    siteId: text('site_id').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteSlugIdx: index('posts_site_slug_idx').on(t.siteId, t.slug),
  }),
);

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
