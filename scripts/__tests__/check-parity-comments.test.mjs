import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCodeComments } from '../docs-i18n/check-parity.mjs';

// B111 — comments inside a fence are prose and get translated, so parity
// compares code with comments removed. Only whole-line comments used to be
// removed, so a translated *trailing* comment read as code drift and two pairs
// carried a blanket `allow code-fences` waiver that hid every other code change.
//
// Each "still reports" case below is the false-negative guard: stripping must
// never hide a difference in the code itself.

const same = (en, vi, lang) => assert.equal(stripCodeComments(en, lang), stripCodeComments(vi, lang));
const differ = (en, vi, lang) =>
  assert.notEqual(stripCodeComments(en, lang), stripCodeComments(vi, lang));

test('a translated trailing comment no longer reads as code drift (B111)', () => {
  // Shapes taken from deployment/cloudflare-pages-ci.md and enterprise/private-submodule.md.
  same(
    'gh secret set CLOUDFLARE_API_TOKEN  # paste the token when prompted\n',
    'gh secret set CLOUDFLARE_API_TOKEN  # dán token khi được hỏi\n',
    'bash',
  );
  same('curl -sI https://docs.lumibase.dev/ # expect 200\n', 'curl -sI https://docs.lumibase.dev/ # mong đợi 200\n', 'bash');
  same(
    '- uses: actions/checkout@v4\n  with:\n    submodules: false   # the private repo is fetched below\n',
    '- uses: actions/checkout@v4\n  with:\n    submodules: false   # repo private được fetch ở bước dưới\n',
    'yaml',
  );
  same('PORT=1989 # local only\n', 'PORT=1989 # chỉ dùng local\n', 'env');
  same('ls  # list\n', 'ls  # liệt kê\n', 'Bash');
});

test('a difference in the code before a trailing comment is still reported', () => {
  differ('gh secret set TOKEN_A  # paste it\n', 'gh secret set TOKEN_B  # dán vào\n', 'bash');
  differ('submodules: false   # why\n', 'submodules: true   # vì sao\n', 'yaml');
  differ('curl -sI https://a.example/ # expect 200\n', 'curl -sI https://b.example/ # mong đợi 200\n', 'bash');
});

test('a URL fragment is code, not a comment', () => {
  assert.equal(stripCodeComments('curl https://x.example/#anchor', 'bash'), 'curl https://x.example/#anchor');
  // No whitespace after the `#` → not a comment, even with whitespace before.
  assert.equal(stripCodeComments('open https://x.example/ #anchor', 'bash'), 'open https://x.example/ #anchor');
  differ('curl https://x.example/#one\n', 'curl https://x.example/#two\n', 'bash');
  // No whitespace before the `#` → part of the word, even with whitespace after.
  assert.equal(stripCodeComments('dotnet new console -lang C# -o app', 'bash'), 'dotnet new console -lang C# -o app');
  differ('dotnet new console -lang C# -o app\n', 'dotnet new console -lang C# -o web\n', 'bash');
});

test('a quoted or expanded `#` is code, not a comment', () => {
  for (const line of [
    'echo "#fff"',
    "echo '#fff'",
    'echo "a # b"',
    "echo 'a # b'",
    'echo "say \\" # still quoted"',
    'echo ${#arr}',
    'echo ${#arr[@]}',
    'echo \\# literal',
    'color: "#fff"',
  ]) {
    assert.equal(stripCodeComments(line, 'bash'), line, line);
  }
  differ('echo "a # b"\n', 'echo "a # c"\n', 'bash');
  differ("title: 'x # one'\n", "title: 'x # two'\n", 'yaml');
  // A comment after a closed quote is still a comment.
  assert.equal(stripCodeComments('echo "#fff"  # colour', 'bash'), 'echo "#fff"');
});

test('whole-line comments are stripped as before, shebang included', () => {
  assert.equal(stripCodeComments('#!/bin/sh\n# install\npnpm install\n', 'sh'), 'pnpm install');
  assert.equal(stripCodeComments('// note\nconst a = 1;\n', 'ts'), 'const a = 1;');
  assert.equal(stripCodeComments('-- note\nSELECT 1;\n', 'sql'), 'SELECT 1;');
  same('# English\nls\n', '# Tiếng Việt\nls\n', 'bash');
});

test('trailing `#` is only treated as a comment in shell/YAML-like fences', () => {
  const line = 'const total = a # b';
  assert.equal(stripCodeComments(line, 'ts'), line);
  assert.equal(stripCodeComments(line, 'json'), line);
  assert.equal(stripCodeComments(line, 'bash'), 'const total = a');
  differ('a # one\n', 'a # two\n', 'typescript');
});

test('an escaped space before `#` keeps the `#` in the word (bash `foo\\ # bar`)', () => {
  assert.equal(stripCodeComments('echo foo\\ # bar', 'bash'), 'echo foo\\ # bar');
  differ('echo foo\\ # one\n', 'echo foo\\ # two\n', 'bash');
  // An unescaped space still starts a comment.
  assert.equal(stripCodeComments('echo foo\\  # bar', 'bash'), 'echo foo\\');
});

test('Dockerfile keeps a mid-line `#`: only a leading `#` is a comment there', () => {
  const line = 'COPY a b # x';
  assert.equal(stripCodeComments(line, 'dockerfile'), line);
  assert.equal(stripCodeComments(line, 'docker'), line);
  differ('COPY a b # one\n', 'COPY a b # two\n', 'dockerfile');
  same('# English\nFROM node:22\n', '# Tiếng Việt\nFROM node:22\n', 'dockerfile');
});

test('translated `//` and `/* */` comments in JS/TS/JSONC are not code drift', () => {
  // Shapes taken from features/email-service.md, features/raw-data-editing.md,
  // features/ai-first-specification.md and features/extensions-system.md.
  same('  "cc": ["lead@example.com"],   // optional\n', '  "cc": ["lead@example.com"],   // tùy chọn\n', 'jsonc');
  same('  schema?: JSONSchema7; // used for monaco validation\n', '  schema?: JSONSchema7; // dùng cho monaco validate\n', 'ts');
  same(
    '  /** Approval state: \'pending\' | \'approved\' */\n  status: text(\'status\'),\n',
    '  /** Trạng thái duyệt: \'pending\' | \'approved\' */\n  status: text(\'status\'),\n',
    'typescript',
  );
  // A translated JSDoc block may wrap onto a different number of lines.
  same('/**\n * Run the skill.\n */\nrun();\n', '/**\n * Thực thi skill.\n * Sau khi duyệt.\n */\nrun();\n', 'ts');
  same('<div>\n  {/* Chat frame */}\n</div>\n', '<div>\n  {/* Khung chat */}\n</div>\n', 'tsx');
  // Trailing whitespace is not code.
  same('const a =\n  b ||\n', 'const a = \n  b || \n', 'ts');
});

test('a difference in JS/TS code around a comment is still reported', () => {
  differ('  "cc": ["a@example.com"],   // optional\n', '  "cc": ["b@example.com"],   // tùy chọn\n', 'jsonc');
  differ('return { message: `Skill does not exist.` };\n', 'return { message: `Skill không tồn tại.` };\n', 'ts');
  differ('/** doc */ run(1);\n', '/** tài liệu */ run(2);\n', 'js');
});

test('`//` and `/*` inside JS strings are code, not comments', () => {
  for (const line of [
    "const url = 'https://x.example/a';",
    'const url = "https://x.example/a";',
    'const url = `https://${host}/a`;',
    "glob('src/**/*.ts');",
    'const s = "a \\" // still quoted";',
  ]) {
    assert.equal(stripCodeComments(line, 'ts'), line, line);
  }
  differ("fetch('https://a.example/x')\n", "fetch('https://b.example/x')\n", 'js');
  // An apostrophe in JSX text does not swallow the following lines.
  assert.equal(stripCodeComments("<p>Don't</p>\nrun(); // go\n", 'tsx'), "<p>Don't</p>\nrun();");
});
