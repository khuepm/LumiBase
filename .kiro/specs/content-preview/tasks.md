# Implementation Plan — Content Preview (B102)

> Trace: mỗi task ghi requirement liên quan (Req n). Tuân non-negotiable rules trong `CLAUDE.md`: nanoid, `siteId`, runtime abstraction, response format, TS strict. DoD: `.kiro/steering/definition-of-done.md`, đặc biệt §2c (route guard) và §2d (shell).
>
> **Trạng thái:** spec, chờ duyệt (2026-09-29). Chưa có code.

## Phase A — Data model

- [ ] 1. Cột `purpose` cho share (Req 2.5, 6.1)
  - [ ] 1.1 Migration viết tay `0019_share_purpose.sql`, kèm journal entry. Số migration lấy cao hơn mọi branch đang mở.
  - [ ] 1.2 Xử lý `created_by` khi user bị xoá cho hàng preview (design §2). Test: xoá user → token preview của họ trả 404, không vi phạm CHECK.
  - [ ] 1.3 Drizzle schema `access.ts`: `purpose`, `roleId` nullable. Mọi call site đọc `share.roleId` xử lý `null`.
  - [ ] 1.4 `ShareService.read` và `list` lọc `purpose = 'share'`. Test: token preview đưa vào `/shares/:token` → 404.

## Phase B — CMS API

- [ ] 2. Tạo token (Req 2)
  - [ ] 2.1 `ShareService.createPreview` + settings `preview.ttlSeconds` (mặc định 900, trần 3600).
  - [ ] 2.2 `POST /items/:collection/:id/preview`: chỉ user principal; đọc item qua `itemServiceForRequest(c)`.
  - [ ] 2.3 Test RBAC dạng `dependents-service-rbac.test.ts`: không có quyền read → 403, không insert.
  - [ ] 2.4 Xác minh editor có chặn sửa item `in_review` không (design §9.2) rồi ghi kết quả vào design.
- [ ] 3. Đọc token (Req 3)
  - [ ] 3.1 `GET /api/v1/preview/:token` mount public cạnh share; đánh giá quyền người tạo.
  - [ ] 3.2 Một body 404 cho mọi lỗi. Test so byte giữa các trường hợp: không có, hết hạn, thu hồi, vượt `maxUses`, người tạo mất quyền.
  - [ ] 3.3 Xác minh rate limit áp cho mount public; nếu không áp thì thêm.
  - [ ] 3.4 `no-store`, `noindex`; test không ghi app cache.
  - [ ] 3.5 Test `auth === undefined` (DoD §2c); cập nhật `security-guards.wiring.test.ts`.
- [ ] 4. `meta.previewUrl` (Req 1)
  - [ ] 4.1 Validate ở `PATCH /collections/:name` (design §3.3), kèm test `javascript:` và placeholder lạ.
  - [ ] 4.2 `buildPreviewUrl` trong `packages/contracts`, kèm unit test encode.

## Phase C — SDK + Studio

- [ ] 5. SDK `items(c).preview(id)` + type.
- [ ] 6. Studio (Req 4)
  - [ ] 6.1 Nút Preview trong `item-detail.tsx`; ẩn/disable theo `previewUrl`, quyền và `isDirty`.
  - [ ] 6.2 Ô Preview URL trong Data model.
  - [ ] 6.3 Shell: mở URL bằng trình duyệt hệ thống trong Tauri (DoD §2d).
  - [ ] 6.4 Component test: dirty → disabled; lỗi hiện inline; popup bị chặn → hiện link.

## Phase D — Starter Next.js (Req 5)

- [ ] 7.1 `app/posts/[slug]/page.tsx`.
- [ ] 7.2 `app/api/preview/route.ts` + `app/api/exit-preview/route.ts` (cookie `httpOnly`).
- [ ] 7.3 `cms:bootstrap` đặt `meta.previewUrl` nếu chưa có.
- [ ] 7.4 `cms:verify`: token đọc được draft; publishable key vẫn 404; token không có trong `.next/static`.
- [ ] 7.5 Test template (`nextjs-template.test.ts`) + behaviour test với stub CMS.

## Phase E — Docs + nghiệm thu

- [ ] 8. Docs EN/VI: `docs/{en,vi}/features/content-preview.md`; `getting-started` có mục preview; `hono-api-spec` thêm hai endpoint. Chạy workflow i18n trong `CLAUDE.md`.
- [ ] 9. Setup Impact Registry: ghi một dòng theo design §8.
- [ ] 10. Nghiệm thu trên starter sạch: tạo draft → Preview → trang hiện draft → publish → thoát preview → trang public hiện bản đã publish. Ghi biên bản ở `docs/review-agent/`.
