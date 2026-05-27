# Hono API Specification

> Base URL: `https://api.lumibase.dev` (configurable). Tất cả endpoint phiên bản hoá dưới `/api/v1`. Yêu cầu header `Authorization: Bearer <jwt>` và `X-Lumi-Site: <siteId>` (hoặc subdomain mapping).

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
- `filter={"status":{"_eq":"published"}}` (JSON urlencoded) hoặc `filter[status][_eq]=published` (bracket)
- `sort=-updated_at,title`
- `page`, `limit` (≤200)
- `search=keyword` (full-text trên fields đánh dấu searchable)
- `aggregate[count]=*` / `aggregate[sum]=price`
- `groupBy=status`
- `deep[author][fields]=name,avatar`

## 2. Auth

- `POST /auth/login` — proxy Logto (PKCE) hoặc local exchange code.
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET  /auth/me`

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

- `POST /files/upload-url` → presigned R2 PUT.
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
