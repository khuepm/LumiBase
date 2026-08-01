/**
 * Safely formats an error object for logging, preventing accidental exposure
 * of sensitive information (like API keys in request/response headers)
 * when the error comes from an external library (e.g. fetch, axios, openai).
 */
export function formatSafeError(err: unknown): Record<string, unknown> | string {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }

  if (typeof err === 'object' && err !== null) {
    // If it's a generic object but not an Error instance, extract safe fields if any
    const safeObj: Record<string, unknown> = {};
    if ('message' in err) safeObj.message = err.message;
    if ('name' in err) safeObj.name = err.name;
    if ('code' in err) safeObj.code = err.code;
    if ('status' in err) safeObj.status = err.status;

    // If we extracted something useful, return it
    if (Object.keys(safeObj).length > 0) {
      return safeObj;
    }
  }

  // Fallback for primitives (strings, numbers, etc.)
  return String(err);
}
