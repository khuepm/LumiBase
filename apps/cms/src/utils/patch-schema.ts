import { z } from 'zod';

/**
 * The `.partial()` object each {@link patchSchema} validates with, keyed by the
 * schema it returned. The returned schema is a `z.unknown().transform(…)`, so
 * neither `z.toJSONSchema` nor a key-set comparison can see through it; the MCP
 * tool-schema fidelity golden (#716) reads the body shape from here instead of
 * reconstructing it.
 */
const PATCH_BODIES = new WeakMap<z.ZodType, z.ZodType>();

/**
 * Validate a shallow PATCH without manufacturing values for omitted keys.
 * Zod 4's partial() still applies inner default()/prefault() values. Retain
 * only validated keys the caller supplied; nested objects are replacements,
 * so their own defaults still apply when the object is explicitly present.
 */
export function patchSchema<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  const partial = schema.partial();
  const patch = z.unknown().transform((input, ctx): z.output<typeof partial> => {
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
  PATCH_BODIES.set(patch, partial);
  return patch;
}

/** The object a {@link patchSchema} result validates the body with; `undefined` for any other schema. */
export function patchBodyOf(schema: z.ZodType): z.ZodType | undefined {
  return PATCH_BODIES.get(schema);
}
