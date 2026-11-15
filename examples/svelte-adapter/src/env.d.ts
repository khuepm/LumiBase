// SvelteKit generates these modules; declared here so the smoke example
// type-checks without a Kit install.
declare module '$env/dynamic/private' {
  export const env: Record<string, string | undefined>;
}
