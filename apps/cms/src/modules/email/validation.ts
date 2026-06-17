/**
 * Zod schemas for the email module HTTP surface. Kept in one file so the
 * routes stay thin (parse → service) and the shapes are reusable by tests.
 */
import { z } from 'zod';

/** Per-site stable key: lowercase letters, digits, `_`/`-`. */
const keySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'key must be kebab/snake, start alphanumeric');

export const layoutCreateSchema = z.object({
  key: keySchema,
  name: z.string().min(1).max(120),
  html: z.string().min(1).max(100_000),
});
export const layoutUpdateSchema = layoutCreateSchema.partial();

export const templateCreateSchema = z.object({
  key: keySchema,
  name: z.string().min(1).max(120),
  layoutId: z.string().max(64).nullable().optional(),
  subject: z.string().min(1).max(500),
  bodyHtml: z.string().min(1).max(200_000),
  bodyText: z.string().max(200_000).nullable().optional(),
  variables: z.array(z.string().max(64)).max(100).default([]),
  enabled: z.boolean().default(true),
});
export const templateUpdateSchema = templateCreateSchema.partial();

/** Render-without-send (preview). Sample variable values keyed by name. */
export const previewSchema = z.object({
  variables: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

const emailAddress = z.string().email().max(254);

/**
 * Send body. Either `templateKey` (render a stored template) or `inline`
 * (ad-hoc subject + body). This is the integration point extensions call.
 */
export const sendSchema = z
  .object({
    to: z.array(emailAddress).min(1).max(50),
    cc: z.array(emailAddress).max(50).optional(),
    replyTo: emailAddress.optional(),
    templateKey: keySchema.optional(),
    inline: z
      .object({
        subject: z.string().min(1).max(500),
        html: z.string().max(200_000).optional(),
        text: z.string().max(200_000).optional(),
      })
      .refine((v) => Boolean(v.html || v.text), {
        message: 'inline requires html or text',
      })
      .optional(),
    variables: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({}),
  })
  .refine((v) => Boolean(v.templateKey) !== Boolean(v.inline), {
    message: 'provide exactly one of templateKey or inline',
  });

/** Send a one-off test mail to a given address (UI "send test"). */
export const testSchema = z.object({
  to: emailAddress,
  templateKey: keySchema.optional(),
  variables: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
});

export type LayoutCreate = z.infer<typeof layoutCreateSchema>;
export type TemplateCreate = z.infer<typeof templateCreateSchema>;
export type SendInput = z.infer<typeof sendSchema>;
