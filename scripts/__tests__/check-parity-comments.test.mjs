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
