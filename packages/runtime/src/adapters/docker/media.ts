import crypto from 'node:crypto';
import type { MediaProcessor, TransformOptions } from '../../interfaces';

/** Minimal structural type for the parts of the Sharp API we use (optional dep). */
interface SharpLike {
  resize(opts: { width?: number; height?: number; fit?: string }): SharpLike;
  toFormat(format: string, opts?: { quality?: number }): SharpLike;
  toBuffer(): Promise<Buffer>;
}

export class ImgproxyMediaProcessor implements MediaProcessor {
  constructor(
    private baseUrl: string,
    private key: string,
    private salt: string,
    private storageUrl: string,
  ) {}

  getUrl(key: string, options?: TransformOptions): string {
    const processing = this.buildProcessingString(options);
    const sourceUrl = `${this.storageUrl}/${key}`;
    const encoded = Buffer.from(sourceUrl).toString('base64url');
    const path = `/${processing}/${encoded}`;
    const signature = this.sign(path);
    return `${this.baseUrl}/${signature}${path}`;
  }

  async generateThumbnails(
    key: string,
    sizes: Array<{ width: number; height: number }>,
  ): Promise<string[]> {
    return sizes.map((size) =>
      this.getUrl(key, { ...size, format: 'webp', quality: 80 }),
    );
  }

  /**
   * In-process byte transform via Sharp (image-transform-dsl task 2). Sharp is
   * an optional dependency loaded dynamically so builds that don't need
   * in-process resizing (and the CF adapter) never pull the native module. When
   * Sharp is absent this throws and the caller (delivery route) falls back to
   * the transform URL.
   */
  async transform(
    input: ArrayBuffer | Uint8Array,
    options: TransformOptions,
  ): Promise<{ body: Uint8Array; contentType: string }> {
    let sharpFn: (buf: Uint8Array) => SharpLike;
    try {
      // sharp is an optional runtime dependency (not in the workspace by default);
      // resolved dynamically so builds/CF never require the native module.
      // @ts-expect-error - optional peer module, may be absent at build time
      const mod = (await import(/* @vite-ignore */ 'sharp')) as unknown as {
        default: (buf: Uint8Array) => SharpLike;
      };
      sharpFn = mod.default;
    } catch {
      throw new Error('sharp is not installed; in-process image transform unavailable');
    }
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let pipeline = sharpFn(bytes);
    if (options.width || options.height) {
      pipeline = pipeline.resize({ width: options.width, height: options.height, fit: options.fit ?? 'cover' });
    }
    const format = options.format ?? 'webp';
    pipeline = pipeline.toFormat(format, options.quality ? { quality: options.quality } : undefined);
    const body = await pipeline.toBuffer();
    return { body: new Uint8Array(body), contentType: `image/${format}` };
  }

  private buildProcessingString(options?: TransformOptions): string {
    if (!options) return 'preset:default';
    const parts: string[] = [];
    if (options.width || options.height) {
      parts.push(
        `rs:${options.fit ?? 'fill'}:${options.width ?? 0}:${options.height ?? 0}`,
      );
    }
    if (options.format) parts.push(`f:${options.format}`);
    if (options.quality) parts.push(`q:${options.quality}`);
    return parts.join('/') || 'preset:default';
  }

  private sign(path: string): string {
    const hmac = crypto.createHmac('sha256', Buffer.from(this.key, 'hex'));
    hmac.update(Buffer.from(this.salt, 'hex'));
    hmac.update(path);
    return hmac.digest('base64url').substring(0, 32);
  }
}
