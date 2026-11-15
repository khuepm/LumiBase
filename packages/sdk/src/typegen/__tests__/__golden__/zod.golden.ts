import { z } from "zod";

export const AuthorsSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  name: z.string(),
  email: z.union([z.string(), z.literal('***')]).nullable().optional(),
});
export type Authors = z.infer<typeof AuthorsSchema>;

export const Blog_postsSchema = z.object({
  id: z.string(),
  status: z.string(),
  updated_at: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  views: z.number().int(),
  rating: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  big_count: z.number().nullable().optional(),
  featured: z.boolean(),
  published_on: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  kind: z.enum(["news","guide","review"]),
  metadata: z.unknown().nullable().optional(),
  location: z.record(z.string(), z.unknown()).nullable().optional(),
  cover: z.string().nullable().optional(),
  gallery: z.array(z.string()).nullable().optional(),
  headline: z.record(z.string(), z.string()),
  author_id: z.string().nullable().optional(),
  tags: z.array(z.union([z.number().int(), z.record(z.string(), z.unknown())])).optional(),
});
export type Blog_posts = z.infer<typeof Blog_postsSchema>;

export const TagsSchema = z.object({
  id: z.number().int(),
  label: z.string(),
});
export type Tags = z.infer<typeof TagsSchema>;

export const LumibaseSchemas = {
  authors: AuthorsSchema,
  blog_posts: Blog_postsSchema,
  tags: TagsSchema,
} as const;
