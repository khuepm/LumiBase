/**
 * Turn picked assets into content markup (#708): the rich-text and markdown
 * editors embed library files through the same picker as file fields. The
 * URL is the version-pinned delivery URL, so "where used" (#706) finds the
 * reference by file id and a replace (#703) is picked up on the next render.
 */
import type { PickedAsset } from '@lumibase/extension-sdk';

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function altOf(asset: PickedAsset): string {
  return asset.alt ?? asset.filenameDownload.replace(/\.[^.]+$/, '');
}

/** HTML for one asset: `<img>` for images, a download link otherwise. */
export function assetHtml(asset: PickedAsset): string {
  const url = escapeAttr(asset.url);
  if (asset.mime.startsWith('image/')) {
    const size = asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : '';
    return `<img src="${url}" alt="${escapeAttr(altOf(asset))}"${size}>`;
  }
  return `<a href="${url}">${escapeAttr(asset.filenameDownload)}</a>`;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

/** Markdown for one asset: `![alt](url)` for images, `[name](url)` otherwise. */
export function assetMarkdown(asset: PickedAsset): string {
  // Parentheses in a URL would end the link early; the delivery URL has none,
  // but an encoded form keeps any future base URL safe too.
  const url = asset.url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
  return asset.mime.startsWith('image/')
    ? `![${escapeMarkdownText(altOf(asset))}](${url})`
    : `[${escapeMarkdownText(asset.filenameDownload)}](${url})`;
}
