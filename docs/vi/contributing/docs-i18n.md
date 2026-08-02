---
title: Docs i18n Sync
sourceLang: en
version: 3
lastUpdated: 2026-08-02T17:29:27.319Z
translatedFrom: en
sourceHash: fe0bd18530a46592
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T17:29:27.319Z
codeVerifiedHash: fe0bd18530a46592
codeVerifiedClaims: 10
---

# Documentation i18n Sync (EN ⇄ VI)

LumiBase phát hành docs ở hai locale: `docs/en` (canonical) và `docs/vi`. Bộ công cụ
i18n sync nằm trong `scripts/docs-i18n/` giữ chúng đồng bộ, phát hiện khi một
file được viết sai ngôn ngữ, báo cáo cặp nào đang lệch, và stamp mỗi file được
quản lý với một version và update timestamp.

**Bản dịch được viết tay, không phải machine translation.** Một người — trên thực
tế là một LLM đọc tài liệu nguồn trực tiếp trong editor — viết phía đích, rồi
`stamp-pair.mjs` ghi lại provenance. Đây là quyết định có chủ ý của dự án (chi phí,
cộng với việc muốn kiểm soát chất lượng thay vì một pipeline không giám sát); nó
được ghi trong `docs/.i18n/TASKS.md` §6. **Không có secret `ANTHROPIC_API_KEY`
trong CI và cũng không cần có**, nên không có gì trong repo này tự dịch.

Đường machine-translation (`--apply`, Anthropic Messages API) vẫn còn trong code
cho ai muốn đảo lại quyết định đó, nhưng nó không được dùng: khi không có key nó
**báo lỗi rõ ràng** thay vì im lặng không làm gì. Trước đây nó chọn cách im lặng,
và CI commit "sync en/vi translations" mỗi lần push docs trong khi không dịch gì cả.

## Nó làm gì

1. **Language detection.** Một bộ dò heuristic (`lang-detect.mjs`) phân loại
   mỗi doc là `vi` hoặc `en` dựa trên phần prose, bỏ qua code block, link và
   front matter. Nó chỉ được tinh chỉnh cho cặp vi/en.
2. **Source-of-truth resolution.** Với mỗi cặp file, bộ công cụ quyết định bên nào
   là nội dung được author và bên nào là bản dịch. Một file dưới `docs/en` mà
   thực chất chứa tiếng Việt được coi là được author bằng tiếng Việt.
3. **No-loss preservation.** Khi một file `en` chứa tiếng Việt và không có
   file tương ứng ở `docs/vi`, nội dung tiếng Việt đó được sao chép vào `docs/vi`
   *trước khi* phía `en` bị viết lại bằng tiếng Anh. Khi một file `en` tiếng Việt
   xung đột với một file `docs/vi` đang tồn tại và khác biệt, bộ công cụ **không**
   ghi đè bất cứ thứ gì — nó sao chép nội dung có nguy cơ vào
   `docs/.i18n/preserved/` và gắn cờ conflict để review thủ công.
4. **Translation planning.** Các target đã stale hoặc bị thiếu được liệt kê thành
   việc cần làm — bộ công cụ báo *cái gì* cần dịch và theo chiều nào; con người
   viết phần chữ. (Đường `--apply` không dùng sẽ dịch với bảo vệ placeholder an
   toàn cho markdown, nên code, link, inline code và HTML không bao giờ được gửi
   tới một API.)
5. **Versioning.** Mỗi file được ghi ra nhận front matter: `version`,
   `lastUpdated`, `sourceLang`, `translatedFrom`, `sourceHash`, `mtEngine`, và
   `syncStatus`. Một target chỉ bị coi là stale khi `sourceHash` của nguồn thay
   đổi, nên stamp lại là idempotent và số version hai locale luôn so sánh được.
6. **Audit trail.** Mỗi lần chạy đều append vào `docs/i18n-sync-log.md` và ghi ra
   một file `docs/.i18n/last-report.json` đọc được bằng máy.

## Chạy nó

```bash
# Detect only — classify files, write log + report, change no docs.
pnpm docs:i18n:detect

# Structural parity of every pair (or one rel). Read-only.
pnpm docs:i18n:parity

# Preserve at-risk Vietnamese content + stamp versions, but do not translate.
pnpm docs:i18n:preserve

# Not used by this project: needs ANTHROPIC_API_KEY and exits 2 without one.
pnpm docs:i18n:sync
```

Dịch một file bằng tay — quy trình thực tế — gồm năm bước:

```bash
# 1. Đọc docs/<src>/<rel>, viết bản dịch vào docs/<tgt>/<rel>.
# 2. Kiểm tra hai bên có còn là cùng một tài liệu.
pnpm docs:i18n:parity <rel>

# 3. Kiểm tra các claim của doc so với source tree (bắt buộc, trước khi stamp).
pnpm docs:i18n:verify <rel>

# 4. Ghi provenance cho cả hai locale (đừng tự viết front matter này bằng tay).
node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified

# 5. Xác nhận cặp đã up-to-date, rồi bỏ các artifact máy sinh.
pnpm docs:i18n:detect
git checkout -- docs/.i18n/last-report.json docs/i18n-sync-log.md
```

Ba checker, ba câu hỏi khác nhau, và sự phân chia đó là có chủ ý:
`docs:i18n:detect` hỏi *cùng một source revision?*; `docs:i18n:parity` hỏi *bản dịch
có phải cùng một tài liệu?*; `docs:i18n:verify` hỏi *những gì nó nói còn đúng với
code?* Một cặp có thể pass một cái và fail hai cái còn lại.

`stamp-pair.mjs` tự chạy check parity và **từ chối stamp** một cặp đã lệch — phía đích
còn ở ngôn ngữ nguồn, mất mục, identifier bị dịch, link sai đích, phần cuối bị cắt.
Stamp là thứ khiến một cặp đọc ra "up-to-date" ở mọi chỗ khác, nên nó là điểm cuối
cùng còn chặn được một bản dịch tệ, và sau nó không có reviewer nào nữa. Chỉ dùng
`--allow-structure-drift` cho trường hợp lệch có chủ ý, và nên đặt waiver
`<!-- check-parity: allow <check> -->` trong doc để lý do nằm ngay cạnh chỗ lệch.
`--verified` cũng từ chối khi còn claim nào stale, và từ chối khi một doc không có
claim nào tooling kiểm được — "không có gì để kiểm" không phải là pass, nên file đó
được stamp mà không kèm cờ và cần người đọc lại.

Quy tắc từng file, thứ tự ưu tiên và backlog còn lại nằm ở `docs/.i18n/TASKS.md`.

Environment variables:

| Variable | Mục đích | Mặc định |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key — chỉ dành cho đường `--apply` không dùng | — |
| `ANTHROPIC_MODEL` | Claude model id | `claude-sonnet-4-6` |
| `ANTHROPIC_BASE_URL` | API base URL (proxy override) | `https://api.anthropic.com` |
| `ANTHROPIC_MAX_TOKENS` | Số output token tối đa mỗi request | `8192` |
| `DOCS_ROOT` | Override docs root (testing/CI) | repo `docs/` |

Khi không có API key, `--apply` thoát với mã `2` và chỉ bạn sang
`docs:i18n:detect` / `docs:i18n:preserve`. Nó không âm thầm hạ cấp.

## CI

`.github/workflows/docs-i18n-sync.yml` chạy khi có thay đổi dưới `docs/**` hoặc
`scripts/docs-i18n/**`:

- **Pull requests:** chạy detect + kiểm code-reference + kiểm parity, tất cả đều
  report-only. Upload các report dưới dạng artifact; không ghi gì cả. Report-only vì
  corpus hiện có vẫn còn finding — cửa thực sự chặn hôm nay là `stamp-pair.mjs`, không
  bản dịch mới nào qua được nó mà chưa được kiểm.
- **Push lên `main`:** preservation + version stamp, rồi commit trở lại. Nó
  **không** dịch, và số cặp còn tồn đọng được in vào job summary để backlog luôn
  nhìn thấy được.

Không có repository secret nào tham gia. Bản dịch vào repo qua pull request, viết
tay, trong cùng commit với thay đổi làm nó cần thiết — xem quy tắc docs song ngữ
trong `CLAUDE.md`.

## Front-matter fields

| Field | Ý nghĩa |
|-------|---------|
| `version` | Số nguyên, tăng khi content thay đổi |
| `lastUpdated` | ISO-8601 timestamp của lần ghi cuối |
| `sourceLang` | Ngôn ngữ được author của file này |
| `translatedFrom` | Locale nguồn mà một file dịch xuất phát từ đó |
| `sourceHash` | Hash của source body mà bản dịch được dựng từ đó |
| `contentHash` | Hash của chính body của file được author (phát hiện thay đổi) |
| `mtEngine` | Bản dịch được tạo ra thế nào: `manual` (viết tay, hiện hành) hoặc `claude` (output cũ của `--apply`) |
| `syncStatus` | `human-translated` (hiện hành), hoặc `machine-translated` / `needs-review` từ đường cũ |
| `codeVerified` | Timestamp lúc các claim về source code của doc được kiểm |
| `codeVerifiedHash` | Body hash mà lần kiểm được ghim vào — sửa body là vô hiệu hoá đảm bảo đó |

`syncStatus`/`sourceHash` trả lời "hai locale có cùng mô tả một source revision
không?"; `codeVerified` trả lời "các claim của doc này về repo đã được kiểm chưa?".
Hai câu hỏi khác nhau: hai bản dịch có thể khớp nhau hoàn hảo và cùng sai. Muốn coi
là khớp hoàn toàn thì cần cả hai cờ.

Docs viewer đọc `lastUpdated` cho ngày "last modified" hiển thị,
quay về dùng filesystem mtime khi field này vắng mặt.

## Limitations

- Detection là heuristic, không phải mô hình ngôn ngữ thống kê; các file ở ranh giới
  (chủ yếu là tiếng Anh với vài thuật ngữ tiếng Việt) có thể cần một stamp `sourceLang`
  thủ công.
- Hướng author mặc định cho một cặp đã in-sync là `en → vi`. Các file
  được author bằng tiếng Việt dưới `docs/en` được phát hiện và xử lý, nhưng các cặp
  thông thường giả định tiếng Anh là canonical.
- Năng suất dịch là năng suất con người, nên backlog lớn tiêu rất chậm: chạy
  `pnpm docs:i18n:detect` để lấy số hiện hành thay vì cho rằng CI đã đuổi kịp.
- Các trang `machine-translated` cũ có từ trước chính sách viết tay và chưa được
  đọc soát hết.
