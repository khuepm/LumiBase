# Bàn giao: dịch docs EN↔VI (nhóm A–E)

> **Xem [`TASKS.md`](./TASKS.md) để lấy danh sách nhiệm vụ hiện hành + quy tắc
> chạy song song nhiều agent.** File này (HANDOFF) chỉ còn giá trị lịch sử/tham
> khảo workflow ban đầu; `TASKS.md` là nguồn sự thật cho tiến độ và bảng claim.

**Branch:** `docs/i18n-full-translation` (từ main `87a82fcb`, v0.17.0)
**Mục tiêu:** dịch thủ công 110 file (~17.400 dòng) → 1 PR lớn. KHÔNG dùng API key.

## Workflow đã kiểm chứng (mỗi file)
1. Đọc `docs/en/<rel>` (nguồn), viết bản dịch vào `docs/vi/<rel>`.
   Giữ nguyên code block, link, path, tên biến, thuật ngữ kỹ thuật.
2. Stamp provenance bằng helper:
   `node <scratchpad>/stamp-pair.mjs <rel> en`  (en=nguồn EN→VI; vi=nguồn VI→EN)
   Helper stamp cả file đích (version/sourceHash/mtEngine/syncStatus) và
   file nguồn (contentHash) — khớp chính xác cách sync.mjs --apply làm.
3. Xác minh: `node scripts/docs-i18n/sync.mjs` (plan mode) → file phải thành `up-to-date`.
4. Trước khi commit: `git checkout -- docs/.i18n/last-report.json docs/i18n-sync-log.md`
   (đây là artifact máy sinh khi detect, KHÔNG commit).
5. Commit `--no-verify` (docs-only, pre-commit hook chạy full test rất chậm).
   Chạy `nvm use 24` cho mọi lệnh node.

## Tiến độ (cập nhật 2026-07-05)
- Đã xong: 17 file nhóm A (2 commit: ae842bd7, a463330c)
  - architecture/decisions/ (index+10 ADR), deployment/private-admin-path,
    sdk/index, cdc/README, features/content-releases, security/{external-jwt-auth,route-guards}
- CÒN LẠI: A=35, B=40, C=16, D=3, E=1

## Nhóm A còn lại (35) — ưu tiên ngắn→dài
architecture/physical-collections, cdc/{architecture,setup-*,deployment-*,environment-variables,troubleshooting},
agent-setup/{index,codex,windsurf,claude-code,cursor,github-copilot,prompt},
contributing/{code-first-config,code-style,docs-i18n,extension-dev,index,testing},
deployment/{cloudflare-pages-ci,shared-domain-environments},
aio/{README,AIO-AUDIT-REPORT}, api/graphql-api-spec, sdk/{typegen,javascript},
features/{deployment-integrations,push-notifications,directus-data-model-parity-tasks},
getting-started, devpost-xprize-submission, DEPLOYMENT-CHECKLIST

## Nhóm D (3, VI→EN, an toàn) — dùng `stamp-pair.mjs <rel> vi`
features/permission-builder-directus-investigation, release/npm-publishing,
roadmap/agent-harness-implementation

## Nhóm B (40) — GHI ĐÈ bản VI cũ, xem git diff cẩn thận trước khi ghi
## Nhóm C (16) — file docs/en đang chứa tiếng Việt → viết lại thành tiếng Anh (source=vi)
## Nhóm E (1) features/user-management.md — CONFLICT: cần người quyết bản nào đúng, KHÔNG tự động

## LƯU Ý
- main merge liên tục → chạy lại `sync.mjs` detect để cập nhật danh sách trước mỗi phiên.
- Không đẩy thẳng vào main; mở PR lớn khi xong (theo yêu cầu ban đầu là "1 branch, 1 PR").
