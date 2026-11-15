export declare const THEMES: readonly ['light', 'dark'];
export interface StoryIndex {
  entries?: Record<string, { id: string; type: string }>;
}
export interface CompareResult {
  changed: Array<{ name: string; ratio: number }>;
  added: string[];
  removed: string[];
  unchanged: number;
}
export declare function storiesFromIndex(index: StoryIndex): string[];
export declare function snapshotName(storyId: string, theme: string): string;
export declare function storyUrl(base: string, storyId: string, theme: string): string;
export declare function compareDirs(
  baseDir: string,
  headDir: string,
  outDir: string,
  options?: { threshold?: number; maxDiffRatio?: number },
): CompareResult;
export declare function summaryMarkdown(result: CompareResult): string;
