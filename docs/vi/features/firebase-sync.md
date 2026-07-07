---
version: 1
lastUpdated: 2026-06-23T09:48:37.000Z
sourceLang: vi
contentHash: 66736ba66e39afe3
---

# LumiBase Firebase Sync

> Extension đồng bộ content (`items`) từ LumiBase sang **Firebase** — Cloud Firestore hoặc Realtime Database — theo thời gian thực, mỗi khi item được tạo/sửa/xoá.

Module: `apps/cms/src/modules/lumibase-firebase-sync/` · Mounted tại `/api/v1/firebase-sync`.

## 1. Mục tiêu & mô hình

Mỗi **pipeline** cấu hình một đích Firebase cho một site. Khi một item trong các collection được chọn thay đổi, LumiBase đẩy thay đổi đó sang Firebase (upsert hoặc delete). Một pipeline = một (site, đích Firebase, bộ collection, bộ action).

- **Edge-native:** connector chỉ dùng `fetch` + Web Crypto (REST), **không** dùng `firebase-admin` SDK (không tương thích Cloudflare Workers).
- **Real-time:** sync được kích hoạt từ `ItemService` ngay sau khi ghi (cạnh `publishRealtimeEvent`), theo kiểu fire-and-forget — lỗi Firebase **không** làm fail request CMS.
- **Backfill:** đẩy toàn bộ item hiện có của collection lên Firebase qua một endpoint riêng.
- **Multi-tenant:** mọi query scope theo `siteId`.

## 2. Hai đích Firebase

| Đích | `target` | Ghi | Xác thực |
|---|---|---|---|
| Cloud Firestore | `firestore` | Mỗi item → 1 document, `PATCH` (upsert) | Service-account JSON → JWT RS256 → OAuth2 access token (cache theo TTL) |
| Realtime Database | `rtdb` | Mỗi item → 1 ref JSON, `PUT` (upsert) | Legacy database secret nối qua `?auth=` |

Delete coi `404` của Firestore là thành công (idempotent).

## 3. Credentials & bảo mật

- Credentials Firebase được **mã hoá at-rest** (AES-GCM qua `CryptoService`) bằng biến môi trường `ENCRYPTION_KEY`, lưu trong cột `credentials_encrypted`.
- Credentials là **write-only**: nhập lúc tạo/cập nhật pipeline; **không** endpoint đọc nào trả về.
- Tất cả endpoint yêu cầu **site-scoped admin** (`requireSiteAdmin`).
- Real-time sync hook chỉ chạy khi `ENCRYPTION_KEY` được cấu hình (credentials phải giải mã được). Nếu thiếu key, `POST /pipelines` trả `400 ENCRYPTION_KEY_REQUIRED`.

Hình dạng credential blob:

```jsonc
// target = "firestore" — service-account JSON (các field thực sự dùng)
{ "project_id": "...", "client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----\n..." }

// target = "rtdb"
{ "databaseUrl": "https://<project>.firebaseio.com", "secret": "<rtdb-secret>" }
```

## 4. Target path

Trường `targetPath` là template, mặc định `{collection}`. Placeholder được nội suy lúc sync:

- `{collection}` → machine-name của collection.
- `{itemId}` → id của item.

Nếu template **không** chứa `{itemId}`, item id được nối làm segment cuối. Ví dụ:

| `targetPath` | collection=`articles`, itemId=`a1` | Kết quả |
|---|---|---|
| `{collection}` | | `articles/a1` |
| `content/{collection}` | | `content/articles/a1` |
| `content/{collection}/{itemId}` | | `content/articles/a1` |

> Mỗi document/ref được ghi kèm field `_lumibaseItemId` để truy vết ngược về item nguồn.

## 5. API

Xem chi tiết request/response trong [hono-api-spec.md §12](../api/hono-api-spec.md). Tóm tắt:

| Method | Path | Mô tả |
|--------|------|-------|
| `POST` | `/api/v1/firebase-sync/pipelines` | Tạo pipeline |
| `GET` | `/api/v1/firebase-sync/pipelines` | Liệt kê pipeline của site |
| `GET` | `/api/v1/firebase-sync/pipelines/:id` | Chi tiết (không trả credentials) |
| `PATCH` | `/api/v1/firebase-sync/pipelines/:id` | Cập nhật config / xoay credentials |
| `DELETE` | `/api/v1/firebase-sync/pipelines/:id` | Xoá pipeline (cascade log) |
| `GET` | `/api/v1/firebase-sync/pipelines/:id/log` | Log các lần sync gần đây |
| `POST` | `/api/v1/firebase-sync/pipelines/:id/backfill` | Đẩy toàn bộ item khớp lên Firebase |

## 6. Khớp pipeline với thay đổi

Một thay đổi item được sync tới pipeline khi **tất cả** đúng:

1. Pipeline `status = 'active'`.
2. `collections` rỗng (mọi collection) **hoặc** chứa machine-name của collection.
3. Action được bật: `syncOnCreate` / `syncOnUpdate` / `syncOnDelete`.

Sync là best-effort theo từng pipeline: một pipeline lỗi được ghi log và chuyển `status='error'` + `statusMessage`, các pipeline khác vẫn chạy.

## 7. Backfill

`POST /pipelines/:id/backfill?limit=N` quét item chưa xoá (`deleted_at IS NULL`) của site, lọc theo collection của pipeline, và upsert lên Firebase. `limit` mặc định 500, tối đa 2000 mỗi lần gọi để nằm trong giới hạn CPU/thời gian của Worker; phân trang bằng các lần gọi lặp lại (response trả `truncated: true` khi chạm `limit`).

## 8. Lưu trữ

| Bảng | Mô tả |
|---|---|
| `lumibase_firebase_sync_pipelines` | Cấu hình pipeline + credentials mã hoá + `lastSyncAt`/`lastSyncItemCount` |
| `lumibase_firebase_sync_log` | Append-only: mỗi lần sync (collection, itemId, action, result, errorMessage, durationMs) |

Migration: các bảng được tạo bởi migration gộp `packages/database/drizzle/0000_lumibase_init.sql`. Xem thêm [data-model.md](../data-model.md).

## 9. Liên quan

- [Webhooks](../api/hono-api-spec.md) — push event HTTP thuần (khác: Firebase Sync mirror nguyên item lên data store).
- [ClickHouse CDC](../cdc/README.md) — replicate sang OLAP store (khác: CDC cho analytics, cần hạ tầng riêng; Firebase Sync nhẹ, per-pipeline qua API).
- [Extension System](./extensions-system.md) — extension sandbox của cộng đồng.
