import { test } from 'node:test';
import assert from 'node:assert/strict';

import { linkTargets } from '../docs-i18n/check-parity.mjs';

test('compares translated Markdown cross-links by file path', () => {
  const en = linkTargets(
    '[same page](#gaps) [other doc](../api/graphql-api-spec.md#abuse-guards)',
  );
  const vi = linkTargets(
    '[cùng trang](#khoảng-trống) [tài liệu khác](../api/graphql-api-spec.md#chống-lạm-dụng)',
  );

  assert.deepEqual(en, { files: ['../api/graphql-api-spec.md'], anchors: 1 });
  assert.deepEqual(vi, en);
});

test('keeps fragments on external URLs', () => {
  assert.deepEqual(linkTargets('[section](https://example.com/guide.md#one)'), {
    files: ['https://example.com/guide.md#one'],
    anchors: 0,
  });
});
