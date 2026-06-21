# Design Document — Regulated / Sensitive Content Readiness

## Overview

Tài liệu thiết kế cho tập năng lực nền tảng giúp LumiBase (CMS) phục vụ dự án dữ liệu nhạy cảm/được quản lý. Thiết kế **mở rộng** các thành phần hiện hữu, **không** viết lại, và giữ LumiBase là CMS đa dụng: mọi năng lực bật/tắt được per-site / per-collection / per-field, mặc định **tắt** để không đổi hành vi cài đặt Tier 1 hiện tại (Req 16.5).

Sáu khối: (A) hardening mã hoá field, (B) phân loại field + audit truy cập, (C) content scheduling, (D) editorial workflow, (E) erasure/retention/SAR, (F) SEO/AIO delivery + ví dụ frontend.

Toàn bộ chạy trên cả hai runtime qua `packages/runtime` abstraction; không service nào import binding Cloudflare trực tiếp (Req 4.3, 16).

## Architecture

### 1. Bản đồ thành phần & điểm chạm

```
┌──────────────── Studio (apps/studio) ────────────────┐
│ content/item-detail • publishAt/unpublishAt fields    │
│ review-queue module • editorial actions               │
│ data-model: field.classification selector             │
└───────────────┬───────────────────────────────────────┘
                │ @lumibase/sdk (+ _seo helper)
                ▼
┌──────────────── CMS (apps/cms, Hono) ────────────────┐
│ routes/items        → ItemService (crypto, schedule, state) │
│ routes/collections  → SchemaService (classification guard)  │
│ routes/deliver      → Publish_Window filter + _seo block    │
│ routes/admin/encryption → key rotate / rewrap               │
│ routes/admin/erasure, /admin/sar, retention settings        │
│ services/crypto-service (envelope, AAD, versioning, fail-closed) │
│ services/item-service processCrypto / softDelete / hardDelete   │
│ services/editorial-service (state machine + Content_Review)     │
│ services/scheduler-worker (QueueProvider + Flows schedule)      │
│ services/erasure-service (hard-delete + crypto-shred + audit)   │
└───────┬───────────────────────┬──────────────────────┘
        ▼                       ▼
  Postgres (Drizzle)      Runtime_Context.keys  ← NEW KeyProvider
  items(+publishAt,…)     CF: Secrets/KV  | Docker: env/*_FILE
  fields(+classification) Runtime_Context.queue (scheduler/rewrap)
  content_reviews         Runtime_Context.cache/storage/search…
  field_access_log
  erasure_requests
  encryption_keys
  audit_log (tamper-evident erasure proof)
```

### 2. Traceability Matrix (requirement ↔ thiết kế)

| Req | Thành phần thiết kế | Section |
|-----|---------------------|---------|
| 1 Fail-closed decrypt | `CryptoService.decrypt` throw + `processCrypto` propagate + Audit | §3, §6.1 |
| 2 AAD binding | `buildAad()` helper + GCM `additionalData` | §6.1 |
| 3 Key versioning/rotation | Ciphertext_Envelope codec + `encryption_keys` + rewrap worker | §4.1, §6.2, §7 |
| 4 KeyProvider/KMS | `packages/runtime` interface + 2 adapter | §5 |
| 5 Field classification | `fields.classification` + SchemaService guard + CompiledField | §4.2, §6.3 |
| 6 Field access audit | `field_access_log` + batch writer | §4.3, §6.4 |
| 7 Scheduling | `items.publishAt/unpublishAt` + Scheduler + deliver filter | §4.4, §6.5, §8 |
| 8 Editorial state machine | transition table + `items.editorial_state` | §6.6 |
| 9 Review/sign-off | `content_reviews` + EditorialService | §4.5, §6.6 |
| 10 Studio | review-queue + editor controls | §9 |
| 11 Erasure/crypto-shred | `erasure_requests` + EraseService + tamper-evident audit | §4.6, §6.7 |
| 12 Retention | Retention_Policy settings + Scheduler sweep | §6.5, §8 |
| 13 SAR export | `/admin/sar/export` + Field_Access_Log | §6.8 |
| 14 SEO/AIO delivery | `_seo` builder trong deliver | §6.9 |
| 15 Ví dụ frontend | `examples/nextjs-sensitive-content` | §10 |
| 16 Compat/ràng buộc | migration additive + flag mặc định off | §4, §11 |

## 3. Nguyên tắc fail-closed (xuyên suốt)

`CryptoService.decrypt` hiện trả `'*** (decryption failed) ***'` (`crypto-service.ts:66`) — **đổi** thành ném `DecryptionError`. `processCrypto` trong `item-service.ts` (≈L1116-1155) bắt lỗi:
- Thao tác đơn-item → propagate lỗi → route trả `{ errors:[{code:'DECRYPTION_FAILED'}] }` HTTP 500 + Audit (Req 1.1, 1.2).
- Thao tác list, collection bật `degradedReadOnFailure` → set field = null + `_decryptError` metadata, vẫn Audit (Req 1.4).
Không bao giờ log ciphertext/khoá/plaintext (Req 1.3).

## 4. Thay đổi dữ liệu (schema)

Quy tắc ID: `nanoid` domain, `uuidv7` audit (Req 16.1). Mọi bảng domain có `site_id` + index. Migration additive/idempotent (Req 16.4).

### 4.1 `encryption_keys` (mới, domain)
`id (nanoid)`, `site_id` (nullable cho khoá global), `key_id` (version string, unique per scope), `status` (`active|retired`), `algo` (`AES-GCM`), `created_at`, `retired_at`. **Không lưu vật liệu khoá** (chỉ metadata; khoá nằm ở KeyProvider).

### 4.2 `fields.classification` (mở rộng)
Thêm cột `classification text default 'none'` vào bảng `fields` (`schema/cms.ts`). Compile vào `CompiledField` (`schema-service.ts:89`).

### 4.3 `field_access_log` (mới, audit — uuidv7)
`id (uuidv7)`, `site_id`, `collection`, `record_ids jsonb`, `fields jsonb`, `actor`, `action`, `request_id`, `timestamp`. Index `(site_id, timestamp)`, `(actor, timestamp)`. RLS site-isolation (Req 6.4).

### 4.4 `items` (mở rộng)
Thêm `publish_at timestamp null`, `unpublish_at timestamp null`, `editorial_state text null` (null = dùng `status` cũ), và (envelope) `dek_wrapped text null`. Index hỗ trợ scheduler: `(site_id, status, publish_at)`, `(site_id, status, unpublish_at)`.

### 4.5 `content_reviews` (mới, domain)
`id (nanoid)`, `site_id`, `item_id` (FK items, **onDelete: set null** để giữ lịch sử review khi erasure), `revision_id`, `requested_by`, `assigned_to` (nullable), `status` (`pending|approved|rejected`), `reason text`, `decided_by`, `decided_at`, `created_at`. RLS site-isolation.

### 4.6 `erasure_requests` (mới, audit-grade — uuidv7)
`id (uuidv7)`, `site_id`, `scope jsonb` (collection + filter), `subject_hash` (hash định danh chủ thể, **không plaintext**), `reason`, `requested_by`, `confirmed_by` (nullable, dual-control), `status` (`pending|confirmed|executing|completed|failed`), `record_count int`, `created_at`, `completed_at`.

> **Quan trọng (Req 11.3):** erasure xoá `items`+`revisions` nhưng **không** cascade-xoá `audit_log`/`field_access_log`. `content_reviews.item_id` dùng `set null` thay vì cascade để chứng cứ review không biến mất.

### Settings mở rộng (bảng `settings`)
- `encryption.envelope` (bool), `encryption.activeKeyId`.
- per-collection: `editorialWorkflow`, `requireSeparateReviewer`, `degradedReadOnFailure`, `unpublishTarget` (`archived|draft`).
- `retention.policies[]` (collection, maxAgeDays, action, anchor).
- `erasureDualControl` (bool).
- `seo.jsonLdType` (default `WebPage`).

## 5. Runtime KeyProvider (dual-deploy)

Thêm vào `packages/runtime`:
- `interfaces/keys.ts`: `KeyProvider { getActiveKey(): {keyId, key}; getKey(keyId): key; listKeys(): KeyMeta[] }`.
- Bổ sung `keys: KeyProvider` vào `RuntimeContext` (`interfaces/runtime.ts`).
- `adapters/cloudflare/keys.ts`: đọc từ Workers Secrets / KV binding (`CloudflareKeyProvider`).
- `adapters/docker/keys.ts`: đọc từ env + `*_FILE` (tái dùng cơ chế secret-file ở `config/production.ts:33-47`).
- `factory.ts`: gắn provider theo `LUMIBASE_RUNTIME`.

Fallback (Req 4.4): nếu không cấu hình multi-key, KeyProvider trả khoá `ENCRYPTION_KEY` với `keyId='v0'` → tương thích ciphertext hiện hữu.

Envelope (Req 4.5): khi bật, mã hoá field = sinh DEK ngẫu nhiên/record → encrypt field bằng DEK → wrap DEK bằng KEK (active) → lưu `items.dek_wrapped`. Crypto-shredding = xoá `dek_wrapped`.

## 6. Thay đổi service

### 6.1 CryptoService (`services/crypto-service.ts`)
- `encrypt(data, ctx)` nhận `ctx={siteId,collection,field,recordId}` → AAD = `buildAad(ctx)` (Req 2); prefix envelope `v{keyId}:` (Req 3.1).
- `decrypt(payload, ctx)`: parse version → chọn khoá qua KeyProvider → giải mã với AAD; thất bại → ném `DecryptionError` (Req 1). Không prefix → `v0` (Req 3.2).
- Giữ nguyên thuật toán AES-GCM, IV 12-byte random.

### 6.2 Codec ciphertext
Helper `parseEnvelope`/`formatEnvelope` ở module riêng để test độc lập (property test round-trip + legacy decode, Req 3.1/3.2).

### 6.3 SchemaService (`services/schema-service.ts`)
- Validate `classification` (Req 5.1); chặn `pii|phi` không `encrypted` → `CLASSIFICATION_REQUIRES_ENCRYPTION` (Req 5.2). Compile vào `CompiledField` (Req 5.3). Audit thay đổi (Req 5.5).

### 6.4 processCrypto + masking (`item-service.ts`, `permission-dsl.ts`)
- Mặc định ẩn field `pii|phi` trừ khi có `read_decrypted` (Req 5.4) — mở rộng `applyFieldMask`/`maskItem` (`permission-dsl.ts:398-419`, `permission-service.ts:181-190`).
- Khi giải mã thành công field `pii|phi` → đẩy vào batch writer Field_Access_Log (Req 6.1, 6.2).

### 6.5 Scheduler + Retention (`services/scheduler-worker.ts`)
- Tái dùng `QueueProvider` (`packages/runtime/src/interfaces/queue.ts`) + mẫu `veto-commit-worker.ts` + Flows `triggerType='schedule'` (`schema/cms.ts:294-321`).
- Tick định kỳ: query item due publish/unpublish (dùng index §4.4), áp transition idempotent (Req 7.3/7.4/7.6), phát revalidation/webhook qua `revalidation.ts`.
- Retention sweep theo policy (Req 12).

### 6.6 EditorialService (`services/editorial-service.ts`, mới)
- Transition table tập trung (Req 8.4); enforce editorial gate khi `editorialWorkflow=true` (Req 8.2); map `editorial_state ↔ status` (Req 8.1). Quản lý `content_reviews` (Req 9). Tách biệt rõ với `veto-service.ts` (AI). Audit mọi transition (Req 8.5).

### 6.7 EraseService (`services/erasure-service.ts`, mới)
- Vòng đời Erasure_Request (Req 11.4, dual-control). Thực thi: hard-delete items+revisions; crypto-shred (xoá `dek_wrapped`) khi envelope; ghi `data_erased` tamper-evident **không** cascade audit (Req 11.2/11.3); revalidation sau xoá (Req 11.5). Mở rộng `item-service` softDelete (≈L707-757) thêm path `hardDelete`.

### 6.8 SAR export (`routes/admin/sar`)
- Thu thập + giải mã dữ liệu chủ thể trong scope; ghi `sar_exported` + Field_Access_Log (Req 13.2); kèm provenance từ revisions (Req 13.3); scope `site_id` (Req 13.4).

### 6.9 Delivery `_seo` (`routes/deliver.ts`)
- Builder dựng `_seo {title,description,canonical,openGraph,jsonLd}` từ field `seo`/`aio` (Req 14.1); `jsonLd` type cấu hình (Req 14.2); loại field bị mask/permission (Req 14.3). Mở rộng `serializeItem` (≈L83-97). Publish_Window filter ở query delivery (Req 7.5) — bổ sung điều kiện `publish_at`/`unpublish_at` cạnh `status='published'` (`deliver.ts:207`).

## 7. Key rotation & rewrap

- `POST /api/v1/admin/encryption/keys/rotate`: thêm khoá active mới (qua KeyProvider), set khoá cũ `retired`, ghi `encryption_key_rotated` (Req 3.5).
- Rewrap worker (queue): quét ciphertext `v(old)`, giải mã + mã hoá lại bằng active, idempotent + resume cursor (Req 3.6).

## 8. Mô hình nền (queue/cron) — không tạo cơ chế mới

Dùng đúng hạ tầng hiện hữu: `QueueProvider` (Bull/Redis ở Docker, Cloudflare Queues ở CF), Flows schedule trigger + `nextRunAt`, safety-net sweep kiểu `sweepDueVetoCommits`. Mọi job idempotent, có backoff như `VETO_COMMIT_MAX_ATTEMPTS`.

## 9. Studio (apps/studio)

- `content/item-detail.tsx`: thêm control `publishAt/unpublishAt` (interface datetime hiện hữu) + hiển thị `editorial_state` + action buttons gated theo quyền (Req 10.1/10.2/10.4).
- Module mới `modules/editorial/review-queue.tsx`: hàng đợi review theo assignee (Req 10.3).
- `modules/data-model`: thêm selector `classification` cho field (Req 5).
- i18n keys `en`/`vi`.

## 10. Ví dụ frontend tham chiếu

`examples/nextjs-sensitive-content` (mở rộng `examples/nextjs-blog`): tiêu thụ delivery tôn trọng Publish_Window, render `_seo`/JSON-LD qua `generateMetadata` + SDK helper, ISR theo tag. README cảnh báo không lộ field `pii|phi` ra public và không đặt token `read_decrypted` ở client (Req 15).

## 11. Tương thích & rollout

- Mọi cột mới nullable/có default; guard `IF NOT EXISTS`; ciphertext cũ đọc qua `v0` (Req 16.4, 3.2).
- Flag mặc định off: `editorialWorkflow=false`, không classification, không scheduling → hành vi không đổi (Req 16.5).
- Rollout đề xuất: A (crypto) → B (classification/audit) → C (scheduling) → D (editorial) → E (erasure/retention/SAR) → F (SEO + ví dụ). Mỗi phase độc lập deploy được.

## 12. Bảo mật & rủi ro cần lưu ý

- KeyProvider sai cấu hình ở production phải fail-fast (Req 4.6) — tránh chạy với khoá dev.
- AAD đổi định dạng = phá tương thích: cố định format một chỗ, có test legacy (Req 2.4, 3.2).
- Crypto-shredding chỉ bất khả phục hồi nếu **không** có bản sao DEK ngoài luồng — design giả định DEK chỉ tồn tại ở `dek_wrapped`; tài liệu vận hành phải nêu rõ ràng buộc này (không phải tuyên bố tuân thủ).
- [Inference] Các năng lực này là **điều kiện cần kỹ thuật**, không phải chứng nhận compliance (HIPAA/GDPR); việc tuân thủ pháp lý đòi hỏi thẩm định + kiểm toán độc lập ngoài phạm vi spec.
