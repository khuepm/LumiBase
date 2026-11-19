/**
 * Linear-time trimming of a character set at the end of a string. A regex
 * like `/ +$/` backtracks quadratically on long runs that are not at the end
 * (`"a" + " ".repeat(n) + "b"`), which hostile rich text can supply.
 */
export function trimEndChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** Number of trailing characters of `text` that are in `chars`. */
export function countTrailing(text: string, chars: string): number {
  return text.length - trimEndChars(text, chars).length;
}
