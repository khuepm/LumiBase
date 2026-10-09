import { z } from 'zod';

/**
 * Validate a shallow PATCH without manufacturing values for omitted keys.
 * Zod 4's partial() still applies inner default()/prefault() values. Retain
 * only validated keys the caller supplied; nested objects are replacements,
 * so their own defaults still apply when the object is explicitly present.
 */
export function patchSchema<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  const partial = schema.partial();
  return z.unknown().transform((input, ctx): z.output<typeof partial> => {
    const result = partial.safeParse(input);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ ...issue });
      return z.NEVER;
    }
    const data = result.data;
    for (const key of Object.keys(data) as Array<keyof typeof data>) {
      // Successful object parsing proves input is an object.
      if (!Object.prototype.hasOwnProperty.call(input, key)) delete data[key];
    }
    return data;
  });
}
