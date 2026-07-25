---
title: Docs i18n Sync
sourceLang: en
version: 1
lastUpdated: 2026-07-08T20:22:56.098Z
translatedFrom: en
sourceHash: e8086806e67522bc
mtEngine: claude
syncStatus: machine-translated
---

# Documentation i18n Sync (EN ⇄ VI)

LumiBase phát hành docs ở hai locale: `docs/en` (canonical) và `docs/vi`. Bộ công cụ
i18n sync nằm trong `scripts/docs-i18n/` giữ chúng đồng bộ, phát hiện khi một
file được viết sai ngôn ngữ, dịch các target đã stale hoặc bị thiếu, và
stamp mỗi file được quản lý với một version và update timestamp.

Việc dịch do Claude thực hiện (Anthropic Messages API) — không có
dịch vụ machine-translation của bên thứ ba nào. Việc dịch chạy trong CI, nơi
`ANTHROPIC_API_KEY` tồn tại dưới dạng secret; ở local bạn có thể chạy detection (và bước
no-loss preservation) mà không cần key nào.

## Nó làm gì

1. **Language detection.** Một bộ dò heuristic (`lang-detect.mjs`) phân loại
   mỗi doc là `vi` hoặc `en` dựa trên phần prose, bỏ qua code block, link và
   front matter. Nó chỉ được tinh chỉnh cho cặp vi/en.
2. **Source-of-truth resolution.** Với mỗi cặp file, bộ công cụ quyết định bên nào
   là nội dung được author và bên nào là bản dịch. Một file dưới `docs/en` mà
   thực chất chứa tiếng Việt được coi là được author bằng tiếng Việt.
3. **No-loss preservation.** Khi một file `en` chứa tiếng Việt và không có
   file tương ứng ở `docs/vi`, nội dung tiếng Việt đó được sao chép vào `docs/vi`
   *trước khi* bất cứ thứ gì dịch đè lên file `en`. Khi một file `en` tiếng Việt
   xung đột với một file `docs/vi` đang tồn tại và khác biệt, bộ công cụ **không**
   ghi đè bất cứ thứ gì — nó sao chép nội dung có nguy cơ vào
   `docs/.i18n/preserved/` và gắn cờ conflict để review thủ công.
4. **Machine translation.** Các target đã stale hoặc bị thiếu được dịch với
   bảo vệ placeholder an toàn cho markdown (code, link, inline code và HTML
   không bao giờ được gửi tới bộ dịch).
5. **Versioning.** Mỗi file được ghi ra nhận front matter: `version`,
   `lastUpdated`, `sourceLang`, `translatedFrom`, `sourceHash`, `mtEngine`, và
   `syncStatus` (`machine-translated` hoặc `needs-review`). Việc dịch lại chỉ
   xảy ra khi `sourceHash` của source thay đổi, nên output ổn định.
6. **Audit trail.** Mỗi lần chạy đều append vào `docs/i18n-sync-log.md` và ghi ra
   một file `docs/.i18n/last-report.json` đọc được bằng máy.

## Chạy nó

```bash
# Detect only — classify files, write log + report, change no docs.
pnpm docs:i18n:detect

# Preserve at-risk Vietnamese content + stamp versions, but do not translate
# (safe to run without an API key).
pnpm docs:i18n:preserve

# Full sync: preserve + translate with Claude + version. Needs ANTHROPIC_API_KEY.
ANTHROPIC_API_KEY=*** pnpm docs:i18n:sync
```

Environment variables:

| Variable | Mục đích | Mặc định |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (bắt buộc để dịch) | — |
| `ANTHROPIC_MODEL` | Claude model id | `claude-sonnet-4-6` |
| `ANTHROPIC_BASE_URL` | API base URL (proxy override) | `https://api.anthropic.com` |
| `ANTHROPIC_MAX_TOKENS` | Số output token tối đa mỗi request | `8192` |
| `DOCS_ROOT` | Override docs root (testing/CI) | repo `docs/` |

Không có API key, `--apply` tự động hạ xuống thành preservation +
versioning và ghi lại lý do trong log.

## CI

`.github/workflows/docs-i18n-sync.yml` chạy khi có thay đổi dưới `docs/**` hoặc
`scripts/docs-i18n/**`:

- **Pull requests:** detect-only. Upload report dưới dạng artifact; không ghi
  gì cả.
- **Push lên `main`:** full sync, sau đó commit kết quả trở lại.

Cấu hình `ANTHROPIC_API_KEY` như một repository secret để việc dịch chạy được.

## Front-matter fields

| Field | Ý nghĩa |
|-------|---------|
| `version` | Số nguyên, tăng khi content thay đổi |
| `lastUpdated` | ISO-8601 timestamp của lần ghi cuối |
| `sourceLang` | Ngôn ngữ được author của file này |
| `translatedFrom` | Locale nguồn mà một file dịch xuất phát từ đó |
| `sourceHash` | Hash của source body mà bản dịch được dựng từ đó |
| `contentHash` | Hash của chính body của file được author (phát hiện thay đổi) |
| `mtEngine` | Engine được dùng (`claude`) |
| `syncStatus` | `machine-translated` hoặc `needs-review` |

Docs viewer đọc `lastUpdated` cho ngày "last modified" hiển thị,
quay về dùng filesystem mtime khi field này vắng mặt.

## Limitations

- Detection là heuristic, không phải mô hình ngôn ngữ thống kê; các file ở ranh giới
  (chủ yếu là tiếng Anh với vài thuật ngữ tiếng Việt) có thể cần một stamp `sourceLang`
  thủ công.
- Hướng author mặc định cho một cặp đã in-sync là `en → vi`. Các file
  được author bằng tiếng Việt dưới `docs/en` được phát hiện và xử lý, nhưng các cặp
  thông thường giả định tiếng Anh là canonical.
- Các bản dịch được Claude tạo ra và output `needs-review` nên được
  đọc soát trước khi release.
- Mỗi tài liệu được dịch trong một request duy nhất; các doc rất dài có thể chạm
  giới hạn `ANTHROPIC_MAX_TOKENS` và cần một giá trị cao hơn (lần chạy sẽ thất bại rõ ràng
  thay vì ghi ra một file bị cắt cụt).
