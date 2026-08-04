---
version: 1
lastUpdated: 2026-07-25T08:16:45.742Z
sourceLang: vi
translatedFrom: vi
sourceHash: e0c7e090b16fd941
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:16:45.742Z
codeVerifiedHash: e0c7e090b16fd941
codeVerifiedClaims: 6
---

# Bookmarks & Presets

> A preset is a shareable list-view state. A bookmark is a preset with a name + icon that appears in the navigation.

## 1. Model

The `presets` table:
- `bookmark` null → the collection's default view for that scope (`userId` or `roleId`).
- `bookmark` set to text → a named bookmark.
- Scope precedence: user > role > site default.

Example `layoutQuery` structure:
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

- On a collection's list page: a "Presets" dropdown showing the user/role/site bookmarks.
- Save current view as: prompts for name + icon + colour + scope (Me / Role X / Everyone).
- Edit / Delete / Set default.

## 3. Smart presets (USP)

- A `refreshInterval` option (seconds) → auto re-fetch.
- A `subscribe: true` option → opens a WebSocket subscription matching the filter; a realtime chip appears in the preset header.
- An `alert` option: if the count exceeds a threshold → create a notification for the owner (Phase 2).

## 4. API

- `GET /presets?collection=&scope=` (automatically merges user/role/site).
- `POST /presets` / `PATCH /presets/:id` / `DELETE /presets/:id`.
- `POST /presets/:id/subscribe` → returns the WS topic.

## 5. UI components

- `PresetSwitcher`, `PresetSaveDialog`, `PresetManagePage` (Settings → Presets).

## 6. Tasks: Phase MVP-C2.
