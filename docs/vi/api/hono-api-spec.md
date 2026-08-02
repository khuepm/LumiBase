---
version: 1
lastUpdated: 2026-07-25T08:11:35.148Z
sourceLang: en
translatedFrom: en
sourceHash: 42b4c9322dccd73d
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:11:35.148Z
codeVerifiedHash: 42b4c9322dccd73d
codeVerifiedClaims: 208
---

# Hono API Specification

> Base URL: `https://api.lumibase.dev` (configurable). Tất cả endpoint phiên bản hoá dưới `/api/v1`. Yêu cầu header `Authorization: Bearer <token>` (token từ login, hoặc API key `lbk_…`) và `X-Lumi-Site: <siteId>` (hoặc subdomain mapping).

## 1. Quy ước response

```json
{ "data": <T>, "meta": { "total": 123, "page": 1, "pageSize": 50 } }
```
Lỗi:
```json
{ "errors": [{ "code": "PERMISSION_DENIED", "message": "...", "path": ["fields","title"], "trace": {} }] }
```

Query params chuẩn cho list:
- `fields=a,b,relation.title`
- `filter` — hai cách tương đương: `filter={"status":{"_eq":"published"}}` (JSON urlencoded) **hoặc** `filter[status][_eq]=published` (bracket). Nếu gửi cả hai trên cùng request thì **JSON thắng**. JSON sai cú pháp → `400 VALIDATION`; key bracket sai → bỏ qua, không fail cả request. Bracket coerce giá trị: `true`/`false` → boolean, `null` → null, số nguyên/thập phân sạch → number (chuỗi `007` giữ là string); toán tử mảng (`_in`, `_nin`, `_between`) nhận giá trị phân tách dấu phẩy.
- `sort=-updated_at,title`
- `page`, `limit` (≤200)
- `search=keyword` (full-text trên fields đánh dấu searchable)
- `aggregate[count]=*` / `aggregate[sum]=price`
- `groupBy=status`
- `deep[author][fields]=name,avatar`

## 2. Auth

- `POST /auth/login` — đổi email/mật khẩu (hoặc Logto auth code) lấy bearer token.
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET  /auth/me`

`POST /auth/login` trả về một `token` duy nhất kèm hồ sơ user (không có `refresh_token`/`expires_in`). Gửi token qua header `Authorization: Bearer <token>` ở các request sau:
```json
{ "data": { "token": "eyJ...", "user": { "id": "usr_...", "email": "admin@example.com", "firstName": "Admin", "lastName": "User", "avatar": null } } }
```
> Cho truy cập server-to-server dài hạn: tạo API key (`POST /api/v1/api-keys`, prefix token `lbk_`) thay vì dùng token login.

## 3. Schema admin

| Method | Path | Mô tả |
|---|---|---|
| GET | `/collections` | list |
| POST | `/collections` | create |
| GET | `/collections/:name` | detail |
| PATCH | `/collections/:name` | update meta |
| DELETE | `/collections/:name` | soft delete |
| GET | `/collections/:name/schema` | export JSON |
| PUT | `/collections/:name/schema` | apply (with diff option) |
| POST | `/collections/diff` | so sánh bundle vs current |
| GET/POST/PATCH/DELETE | `/fields/:collection/:field` | quản lý field |
| GET/POST/PATCH/DELETE | `/relations` | quản lý relation |

## 4. Items (CRUD generic)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/items/:collection` | list (filter/sort/paginate) |
| POST | `/items/:collection` | create (array body = bulk) |
| GET | `/items/:collection/:id` | detail |
| PATCH | `/items/:collection/:id` | partial update |
| PUT | `/items/:collection/:id` | replace |
| DELETE | `/items/:collection/:id` | delete (or array bulk) |
| POST | `/items/:collection/:id/raw` | bulk raw replace |
| GET | `/items/:collection/:id/revisions` | revision list |
| POST | `/items/:collection/:id/revert` | revert to revision |

Headers tuỳ chọn:
- `X-Lumi-Draft: true` để fetch bản nháp.
- `X-Lumi-Locale: vi` để translation render server-side.

## 5. Permissions / Roles / Policies

- `GET /permissions/me` — ma trận hiệu lực cho user hiện tại.
- `POST /permissions/check` — debug rule eval.
- CRUD: `/roles`, `/policies`, `/policies/:id/permissions`.
- `POST /policies/:id/attach` — gắn vào role/user/team.

## 6. Users / Teams / Sessions

- CRUD `/users`, `/teams`.
- `POST /users/invite`.
- `POST /users/:id/impersonate`.
- `GET /users/:id/sessions`, `DELETE /sessions/:id`.

## 7. Files

- `POST /files/presigned-url` → presigned R2 PUT.
- `POST /files` body metadata sau khi upload xong.
- `GET /files`, `/files/:id`, `PATCH`, `DELETE`.
- `GET /assets/:id?width=&height=&format=webp` — transform (Workers image).

## 8. Presets & Bookmarks

- CRUD `/presets`.
- `POST /presets/:id/subscribe` → trả topic WS.

## 9. Translations

- `GET /translations` (filter).
- `POST /translations/bulk`.
- `POST /translations/auto` (MT).

## 10. Settings

- `GET /settings` / `PATCH /settings`.
- `GET /settings/:key` / `PUT /settings/:key`.
- `POST /settings/export`, `POST /settings/apply`.

## 11. Webhooks

- CRUD `/webhooks`.
- `POST /webhooks/:id/test`.

## 12. Extensions

- `GET /extensions`, `POST /extensions/upload` (multipart).
- `POST /extensions/:id/enable` / `/disable`.
- `POST /extensions/:id/capabilities` — grant.
- `GET /extensions/ui/manifest` (cho Studio dynamic import).

## 13. Delivery (public)

- `GET /api/v1/deliver/page/:slug` — page hydration (xem `architecture/page-hydration.md`).
- `GET /api/v1/deliver/items/:collection` — public read, áp role `public`.
- `GET /api/v1/deliver/menu/:key` — menu config.

## 14. Realtime

- `GET /realtime` (WebSocket upgrade) — xem `features/websockets-realtime.md`.

## 15. Utils

- `POST /utils/render-template` — render display template server-side.
- `POST /utils/jsonata/test` — eval rule debug.
- `GET /utils/health`, `/utils/version`.

## 16. Rate limits

- Auth: 30 req/min/IP.
- Items write: 600/min/user.
- Items read: 6000/min/user (cache hỗ trợ giảm).
- Realtime: như mục 5 của doc websockets.

## 17. Versioning

- Header `X-Lumi-API-Version: 1` (mặc định). Breaking thay đổi → tăng version path `/api/v2`. Giữ v1 ít nhất 12 tháng.
