import { z } from 'zod';

export const DEFAULT_PROJECT_THEME = null;

export function normalizeSiteUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.pathname === '/') {
    url.pathname = '';
  } else {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export const projectConfigurationSchema = z.object({
  defaultLanguage: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, {
      message: 'Use a language tag like en, vi, or en-US.',
    }),
  siteUrl: z
    .string()
    .trim()
    .min(1, { message: 'Site URL is required.' })
    .superRefine((value, ctx) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Site URL must start with http:// or https://.',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter a valid site URL.',
        });
      }
    })
    .transform(normalizeSiteUrl),
  displayTitle: z
    .string()
    .transform((value) => value.replace(/[\u0000-\u001F\u007F]/g, '').trim())
    .pipe(
      z
        .string()
        .min(2, { message: 'Display title must be at least 2 characters.' })
        .max(80, { message: 'Display title must be 80 characters or fewer.' }),
    ),
  theme: z.null().optional().default(DEFAULT_PROJECT_THEME),
});

export type ProjectConfigurationFormValues = z.infer<
  typeof projectConfigurationSchema
>;
