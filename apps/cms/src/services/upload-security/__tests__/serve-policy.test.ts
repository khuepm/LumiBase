import { describe, expect, it } from 'vitest';
import { validateUploadFilename } from '@lumibase/contracts/schemas';
import { contentDispositionFor, dispositionTypeFor, userContentHeaders, USER_CONTENT_CSP } from '../serve-policy';

describe('Content-Disposition policy', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'IMAGE/PNG; charset=binary'])(
    '%s is allowed inline',
    (mime) => {
      expect(dispositionTypeFor(mime)).toBe('inline');
    },
  );

  it.each([
    'image/svg+xml',
    'application/pdf',
    'text/html',
    'application/xhtml+xml',
    'text/plain',
    'text/csv',
    'application/octet-stream',
    'application/javascript',
    'text/xml',
    '',
    undefined,
    null,
  ])('%s is forced to attachment', (mime) => {
    expect(dispositionTypeFor(mime)).toBe('attachment');
  });

  it('always pairs the disposition with nosniff and a sandboxing CSP', () => {
    const headers = userContentHeaders('image/png', 'sites/s/media/logo.png');
    expect(headers).toEqual({
      'Content-Disposition': 'inline; filename="logo.png"',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': USER_CONTENT_CSP,
    });
    expect(USER_CONTENT_CSP).toContain('sandbox');
    expect(USER_CONTENT_CSP).toContain("default-src 'none'");
  });

  it('strips RTL-override spoofing, quotes and control characters from the filename', () => {
    expect(contentDispositionFor('application/pdf', 'invoice\u202Egnp.exe')).toBe(
      'attachment; filename="invoicegnp.exe"',
    );
    expect(contentDispositionFor('text/plain', 'a"b\\c\r\nSet-Cookie: x.txt')).toBe(
      'attachment; filename="a_b_c__Set-Cookie: x.txt"',
    );
  });

  it('adds an RFC 5987 filename* for non-ASCII names with an ASCII fallback', () => {
    expect(contentDispositionFor('image/png', 'ảnh đẹp.png')).toBe(
      "inline; filename=\"_nh __p.png\"; filename*=UTF-8''%E1%BA%A3nh%20%C4%91%E1%BA%B9p.png",
    );
  });
});

describe('upload filename validation', () => {
  it.each([
    ['photo.png'],
    ['Annual Report 2026.v2.pdf'],
    ['ảnh-đẹp.jpg'],
    ['data.csv'],
    ['notes.md'],
  ])('accepts %s', (name) => {
    expect(validateUploadFilename(name)).toBeNull();
  });

  it.each([
    ['shell.php.png', 'dangerous_extension'],
    ['x.html.jpg', 'dangerous_extension'],
    ['invoice.pdf.exe', 'dangerous_extension'],
    ['evil.PHTML.gif', 'dangerous_extension'],
    ['payload.svgz', 'dangerous_extension'],
    ['photo.png\u0000.php', 'control_char'],
    ['line\nbreak.png', 'control_char'],
    ['invoice\u202Egnp.exe', 'bidi_control'],
    ['report\u2066fdp.js', 'bidi_control'],
    ['../../etc/passwd.png', 'path_traversal'],
    ['dir\\evil.png', 'path_traversal'],
    ['shell.php.', 'trailing_dot_or_space'],
    ['image.png ', 'trailing_dot_or_space'],
    ['   ', 'empty'],
    [`${'a'.repeat(300)}.png`, 'too_long'],
  ])('rejects %j (%s)', (name, issue) => {
    expect(validateUploadFilename(name)).toBe(issue);
  });
});
