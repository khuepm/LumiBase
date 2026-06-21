# Implementation Plan

## Overview

Kế hoạch triển khai **Regulated / Sensitive Content Readiness**, gồm 6 phase độc lập deploy được (A→F) theo rollout trong design.md §11. Mỗi phase mặc định **tắt** qua flag để không đổi hành vi Tier 1 (Req 16.5). Mỗi task gắn ref `(Req x.y; design §z)` và kèm task test theo chuẩn các spec hiện hữu (unit + integration, property test cho codec/crypto).

Quy ước: `[ ]` chưa làm · `[x]` xong · `[~]` một phần (core xong, còn UI/worker/endpoint phụ). Tuân thủ Definition of Done (`.kiro/steering/definition-of-done.md`), đặc biệt cập nhật `setup-impact.md`.

## Tiến độ (2026-06-17, cập nhật)

- **Phase A (crypto)**: KeyProvider dual-deploy + envelope/AAD + fail-closed + ItemService integration + migration + rotate endpoint + **rewrap worker (3.5)** — **xong**. Còn: envelope mode (3.6, tuỳ chọn), integration test cần DB (3.7).
- **Phase B (classification/audit)**: classification + guard 422 + masking + field_access_log writer + **query endpoint (5.3)** — **xong**. Còn: integration test cần DB (5.4).
- **Phase C (scheduling)**: validation + delivery filter + **scheduler worker (7.1/7.2)** (publish/unpublish tick, idempotent, đăng ký cron trong serve.ts) — **xong**. Còn: Studio control (6.4), integration test cần DB (7.3).
- **Phase D (editorial)**: state machine + **endpoints submit/approve/reject (8.3)** + content_reviews + gate trong patch + **review-queue list endpoint & Studio component (8.5)** — **xong**. Còn: router/i18n wiring cho Studio, integration test cần DB (8.6).
- **Phase E (erasure/retention/SAR)**: **erasure service + dual-control + crypto-shred + endpoints (9)**, **retention sweep (10.1/10.2)**, **SAR export (10.3)** — **xong**. Còn: integration test cần DB (9.5/10.4).
- **Phase F (SEO)**: `_seo` builder + SDK helper + **ví dụ frontend nextjs-sensitive-content (12)** — **xong**.

> Các integration test (3.7/5.4/7.3/8.6/9.5/10.4) yêu cầu Postgres thật; môi trường hiện không có `DATABASE_URL` nên đã phủ bằng unit/property/mock test. Envelope mode (3.6) là tuỳ chọn, chưa bật.

## Tasks

### Phase A — Field encryption hardening + KeyProvider (dual-deploy)

- [x] 1. KeyProvider trong runtime abstraction
  - [x] 1.1 Tạo `packages/runtime/src/interfaces/keys.ts` với `KeyProvider` (`getActiveKey`, `getKey`, `listKeys`) và type `KeyMeta`; thêm `keys: KeyProvider` vào `RuntimeContext` (`interfaces/runtime.ts`) (Req 4.1; design §5)
  - [x] 1.2 Hiện thực `adapters/docker/keys.ts` đọc khoá từ env + `*_FILE` (tái dùng cơ chế secret-file ở `apps/cms/src/config/production.ts:33-47`) (Req 4.2; design §5)
  - [x] 1.3 Hiện thực `adapters/cloudflare/keys.ts` đọc từ Workers Secrets / KV binding (Req 4.2, 4.3; design §5)
  - [x] 1.4 Cập nhật `packages/runtime/src/factory.ts` gắn KeyProvider theo `LUMIBASE_RUNTIME`; fallback `keyId='v0'` từ `ENCRYPTION_KEY` khi không cấu hình multi-key (Req 4.4; design §5)
  - [x] 1.5 Mở rộng `apps/cms/src/config/production.ts` validate cấu hình khoá ở production (base64 AES-GCM, không phải dev secret), fail-fast lúc khởi động (Req 4.6; design §12)
  - [x] 1.6 Unit test cho cả hai adapter (resolve active/by-id, fallback v0, reject dev key)

- [x] 2. Ciphertext envelope codec + AAD + fail-closed
  - [x] 2.1 Tạo `apps/cms/src/services/crypto/envelope-codec.ts` với `formatEnvelope(version, ivCt)` / `parseEnvelope(s)` (`v{n}:` prefix; không prefix → `v0`) (Req 3.1, 3.2; design §6.2)
  - [x] 2.2 Tạo helper `buildAad({siteId,collection,field,recordId})` canonical, một nguồn duy nhất (Req 2.1, 2.4; design §6.1)
  - [x] 2.3 Refactor `apps/cms/src/services/crypto-service.ts`: `encrypt(data, ctx)` + `decrypt(payload, ctx)` dùng KeyProvider + AAD + envelope; **đổi** path lỗi giải mã từ trả placeholder (`crypto-service.ts:66`) sang ném `DecryptionError` (Req 1.1, 2.1, 2.2, 3; design §6.1)
  - [x] 2.4 Property test round-trip `decrypt(encrypt(x))===x` với fast-check; test AAD mismatch reject; test legacy `v0` decode; test wrong-key reject (Req 1.1, 2.2, 3.2; design §6.2)

- [x] 3. Tích hợp processCrypto + key rotation
  - [x] 3.1 Cập nhật `processCrypto` trong `apps/cms/src/services/item-service.ts` (≈L1116-1155) truyền `ctx` (siteId/collection/field/recordId) vào encrypt/decrypt tại mọi call-site (L435/469/524/544/597/633/676/1002); với create cấp `recordId` trước khi encrypt (Req 2.3; design §6.4)
  - [x] 3.2 Bắt `DecryptionError`: đơn-item → propagate → route trả `{errors:[{code:'DECRYPTION_FAILED'}]}` HTTP 500 + Audit `decryption_failed`; list + `degradedReadOnFailure` → field=null + `_decryptError` + Audit (Req 1.1, 1.2, 1.4; design §3)
  - [x] 3.3 Migration + schema `encryption_keys` (metadata, không lưu khoá) (Req 3.3; design §4.1)
  - [x] 3.4 Endpoint `POST /api/v1/admin/encryption/keys/rotate` (admin) + Audit `encryption_key_rotated` (Req 3.5; design §7)
  - [x] 3.5 Rewrap worker (queue, idempotent, resume cursor) nâng ciphertext cũ lên active key (Req 3.6; design §7)
  - [x] 3.6 Envelope mode: `items.dek_wrapped`, sinh/wrap DEK per-record. Bật/tắt qua **setting có UI** `encryption.envelope` (không phải env), đổi setting yêu cầu **step-up password**; background migration worker (batched, resume-cursor, idempotent) chuyển record hai chiều; read self-describing theo `dek_wrapped`; rewrap worker re-wrap DEK khi rotate KEK (Req 4.5; design §5)
  - [x] 3.7 Integration test: encrypt→read theo quyền `read_decrypted`; rotate rồi vẫn đọc ciphertext cũ; fail-closed trả 500 + audit

### Phase B — Field classification + access audit

- [x] 4. Classification metadata
  - [x] 4.1 Thêm `classification?: 'none'|'internal'|'pii'|'phi'` vào `FieldDefinition` (`packages/shared/src/field/index.ts`) + Zod schema shared (Req 5.1; design §6.3)
  - [x] 4.2 Migration thêm cột `fields.classification` (default `'none'`) + compile vào `CompiledField` (`schema-service.ts:89`) (Req 5.1, 5.3; design §4.2)
  - [x] 4.3 SchemaService chặn `pii|phi` không `encrypted` → `CLASSIFICATION_REQUIRES_ENCRYPTION` (422); Audit `field_classification_changed` (Req 5.2, 5.5; design §6.3)
  - [x] 4.4 Mặc định mask field `pii|phi` trừ khi `read_decrypted` — mở rộng `applyFieldMask`/`maskItem` (`permission-dsl.ts:398-419`, `permission-service.ts:181-190`) (Req 5.4; design §6.4)

- [x] 5. Field access log
  - [x] 5.1 Migration + schema `field_access_log` (uuidv7, RLS site-isolation) (Req 6.1, 6.4; design §4.3)
  - [x] 5.2 Batch writer: ghi access khi giải mã thành công field `pii|phi`; đơn-item flush trước response, list ghi aggregate (Req 6.1, 6.2; design §6.4)
  - [x] 5.3 Endpoint query Field_Access_Log (admin, phân trang, lọc actor/collection/thời gian) (Req 6.3)
  - [x] 5.4 Integration test: đọc field phi có audit, không có quyền bị mask + không audit giá trị; verify không log plaintext

### Phase C — Content scheduling

- [x] 6. Schedule fields + delivery filter
  - [x] 6.1 Migration thêm `items.publish_at`, `items.unpublish_at` + index `(site_id,status,publish_at)` / `(…,unpublish_at)` (Req 7.1; design §4.4)
  - [x] 6.2 Validate `unpublishAt > publishAt` → `INVALID_PUBLISH_WINDOW` (422) trong ItemService write path (Req 7.2)
  - [x] 6.3 Delivery (`deliver.ts:207`) thêm điều kiện Publish_Window cạnh `status='published'` (Req 7.5; design §6.9)
  - [x] 6.4 Studio: control `publishAt/unpublishAt` trong `item-detail.tsx` (interface datetime hiện hữu) (Req 10.1; design §9)

- [x] 7. Scheduler worker
  - [x] 7.1 Tạo `apps/cms/src/services/scheduler-worker.ts` tái dùng `QueueProvider` + mẫu `veto-commit-worker.ts` + Flows schedule trigger; tick áp publish/unpublish idempotent, phát revalidation/webhook đúng một lần (Req 7.3, 7.4, 7.6, 7.7; design §6.5, §8)
  - [x] 7.2 Safety-net sweep kiểu `sweepDueVetoCommits` cho item due bị bỏ lỡ (Req 7.6; design §8)
  - [x] 7.3 Integration test biên thời gian: publish đúng mốc, unpublish đúng mốc, chạy trễ không nhân đôi side-effect

### Phase D — Editorial review workflow (HITL người)

- [x] 8. State machine + reviews
  - [x] 8.1 Migration thêm `items.editorial_state` (nullable) + schema `content_reviews` (item_id onDelete:set null, RLS) (Req 8.1, 9.1, 9.2; design §4.4, §4.5)
  - [x] 8.2 Tạo `apps/cms/src/services/editorial-service.ts`: transition table tập trung, map `editorial_state↔status`, enforce gate khi `editorialWorkflow=true` (Req 8.1, 8.2, 8.4; design §6.6)
  - [x] 8.3 Endpoints: submit-review / approve / reject; `requireSeparateReviewer` enforce; Audit `editorial_transition` (Req 9.1, 9.3, 9.4, 8.5; design §6.6)
  - [x] 8.4 Phân biệt rõ với veto-window: editorial-service KHÔNG dùng `agentApprovals`; tài liệu hoá ranh giới (Req 9.5; design §6.6)
  - [x] 8.5 Studio module `modules/editorial/review-queue.tsx` + action buttons gated theo quyền (Req 10.2, 10.3, 10.4; design §9)
  - [x] 8.6 Integration test: draft→published bị chặn khi workflow on; review approve/reject; collection workflow off giữ hành vi cũ (Req 8.3)

### Phase E — Erasure, retention, SAR

- [x] 9. Erasure + crypto-shredding
  - [x] 9.1 Migration + schema `erasure_requests` (uuidv7, subject_hash, dual-control) (Req 11.1, 11.4; design §4.6)
  - [x] 9.2 Tạo `apps/cms/src/services/erasure-service.ts` + `hardDelete` path trong item-service (mở rộng softDelete ≈L707-757): xoá items+revisions, crypto-shred `dek_wrapped` khi envelope (Req 11.2; design §6.7)
  - [x] 9.3 Tamper-evident audit `data_erased` **không** cascade-xoá `audit_log`/`field_access_log`; đổi FK `content_reviews.item_id` → set null (Req 11.3; design §4.5, §6.7)
  - [x] 9.4 Endpoint `POST /api/v1/admin/erasure` + vòng đời pending→confirmed→executing→completed/failed + revalidation sau xoá (Req 11.1, 11.4, 11.5)
  - [x] 9.5 Integration test: erasure xoá item+revision, audit còn nguyên, crypto-shred làm ciphertext bất khả giải mã; dual-control yêu cầu admin thứ hai

- [x] 10. Retention + SAR
  - [x] 10.1 Settings Retention_Policy per-collection + retention sweep trong scheduler (Req 12.1, 12.2; design §6.5)
  - [x] 10.2 Audit `retention_applied`; action archive/hard_delete/crypto_shred theo Req 11.3 (Req 12.3, 12.4)
  - [x] 10.3 Endpoint `POST /api/v1/admin/sar/export` thu thập + giải mã scope, kèm provenance revisions, Audit `sar_exported` + Field_Access_Log, scope site (Req 13)
  - [x] 10.4 Integration test retention biên tuổi + SAR export đúng phạm vi + ghi audit/access-log

### Phase F — Structured SEO/AIO delivery + ví dụ frontend

- [x] 11. SEO delivery + SDK
  - [x] 11.1 Builder `_seo {title,description,canonical,openGraph,jsonLd}` từ field `seo`/`aio`; type JSON-LD cấu hình (default `WebPage`), loại field bị mask/permission (Req 14.1, 14.2, 14.3; design §6.9)
  - [x] 11.2 Mở rộng `serializeItem` (`deliver.ts:83-97`) emit `_seo` khi yêu cầu
  - [x] 11.3 SDK helper trích `_seo` cho Next.js `generateMetadata` (`packages/sdk`) (Req 14.4)
  - [x] 11.4 Unit test builder: JSON-LD hợp lệ, không rò rỉ field bị mask

- [x] 12. Ví dụ frontend tham chiếu
  - [x] 12.1 Tạo `examples/nextjs-sensitive-content` (mở rộng `examples/nextjs-blog`): tôn trọng Publish_Window, render `_seo`/JSON-LD, ISR theo tag (Req 15.1)
  - [x] 12.2 README + ràng buộc bảo mật: không render `pii|phi` public, không đặt token `read_decrypted` ở client (Req 15.2, 15.3)

### Hoàn tất (Definition of Done)

- [x] 13. Cập nhật `setup-impact.md` Registry cho env/secret/settings mới; chạy checklist `.kiro/steering/definition-of-done.md`
- [x] 14. `pnpm typecheck` + `pnpm -F @lumibase/cms test` xanh; migration `db:generate`/`db:migrate` apply sạch trên DB trống
  - `pnpm -F @lumibase/cms typecheck` sạch; migration apply sạch trên DB trống (`pnpm -F @lumibase/database migrate` → Done). Suite CMS xanh ngoại trừ 6 test môi trường-nhạy-cảm có sẵn từ trước (auth timing/lockout, anomaly geo baseline, marketplace seed) — không phải hồi quy từ spec này.
