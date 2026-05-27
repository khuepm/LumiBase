# Bookmarks & Presets

> Preset = trạng thái list view có thể chia sẻ. Bookmark = preset có tên + icon hiện ở navigation.

## 1. Mô hình

Bảng `presets`:
- `bookmark` null → default view của collection cho scope (`userId` hoặc `roleId`).
- `bookmark` text → bookmark có tên.
- Scope precedence: user > role > site default.

Cấu trúc `layoutQuery` ví dụ:
```json
{
  "tabular": {
    "fields": ["title","status","user_updated","updated_at"],
    "page": 1,
    "limit": 50,
    "sort": ["-updated_at"]
  }
}
```

`filter`:
```json
{
  "_and": [
    { "status": { "_in": ["draft","review"] } },
    { "user_created": { "_eq": "$CURRENT_USER" } }
  ]
}
```

## 2. UX

- Trên list page collection: dropdown "Presets" hiển thị bookmarks user/role/site.
- Save current view as: prompt name + icon + color + scope (Me / Role X / Everyone).
- Edit / Delete / Set default.

## 3. Smart preset (USP)

- Tuỳ chọn `refreshInterval` (giây) → auto re-fetch.
- Tuỳ chọn `subscribe: true` → mở WebSocket subscription theo filter; chip realtime trên header preset.
- Tuỳ chọn `alert`: nếu count > threshold → tạo notification cho owner (Phase 2).

## 4. API

- `GET /presets?collection=&scope=` (auto merge user/role/site).
- `POST /presets` / `PATCH /presets/:id` / `DELETE /presets/:id`.
- `POST /presets/:id/subscribe` → returns WS topic.

## 5. UI components

- `PresetSwitcher`, `PresetSaveDialog`, `PresetManagePage` (Settings → Presets).

## 6. Tasks: Phase MVP-C2.
