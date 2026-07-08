export interface TransformOptions {
  width?: number;
  height?: number;
  format?: 'webp' | 'avif' | 'jpeg' | 'png';
  quality?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

export interface MediaProcessor {
  getUrl(key: string, options?: TransformOptions): string;
  generateThumbnails(key: string, sizes: Array<{ width: number; height: number }>): Promise<string[]>;
  /**
   * Optional in-process byte transform (image-transform-dsl task 2). When an
   * adapter implements it, the delivery route can transform bytes directly
   * (e.g. Sharp on Docker) instead of redirecting to a transform URL. Adapters
   * that only build URLs (CF Image Resizing, Imgproxy) leave this undefined and
   * the route falls back to `getUrl`. Returns the transformed bytes + mime.
   */
  transform?(
    input: ArrayBuffer | Uint8Array,
    options: TransformOptions,
  ): Promise<{ body: Uint8Array; contentType: string }>;
}
