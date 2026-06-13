# Design Document — Studio Ops UI

## Overview

Ba bề mặt UI mới, mỗi cái gắn vào module Studio sẵn có gần nhất — không tạo module/route top-level mới ngoài một trang Settings. Fetch theo pattern từng module đang dùng (fetch + `getActiveToken()/getActiveSite()`, response `{data}|{errors}`).

## Architecture

### 1. Materialize manager — Settings page mới

- `settings/materialize-page.tsx` (`MaterializePage`), đăng ký vào Settings sidebar nav + router (×2 Admin_Base) cùng pattern các settings page hiện có (`types-page`, `webhooks-page`…).
- Local `apiFetch` helper theo pattern `agent-harness-page.tsx`.
- State: react-query `['materialize-list']`; mutations create/refresh/delete invalidate list.
- Form create: collection picker tái dùng cách `intent-composer` load schema API (fallback nhập tay); target validate regex trước khi submit; strategy radio; cron input hiện khi `cron`.
- Delete: confirm 2 bước (nút → "Confirm drop") vì drop bảng vật lý không revert được.

### 2. TM manager — màn mới trong module translations

- `translations/tm-page.tsx` (`TranslationMemoryPage`) + route ×2; link từ màn translations hiện có (tab/sub-nav cục bộ của module).
- 3 khối: bảng entries (filter lang pair), form upsert, panel thử Lookup/Translate (2 form nhỏ, render kết quả inline).
- react-query `['tm-entries', source, target]`; upsert invalidate.

### 3. Marketplace publish — dialog trong trang sẵn có

- `settings/marketplace-page.tsx`: thêm nút "Publish extension" mở dialog form (extension select từ `GET /api/v1/extensions`, các field chữ ký); submit → `POST /api/v1/marketplace/publish` → invalidate catalog query.

## Error Handling

Pattern chung của Studio: message từ `errors[0].message`, hiển thị cạnh form/row gây lỗi; mutation pending → disable control tương ứng (không disable cả trang).

## Testing Strategy

Mỗi trang một file test theo convention settings/mission-control hiện hành (mock fetch hoặc module API bằng `vi.hoisted`, QueryClientProvider):

1. **materialize-page**: render list; create gửi đúng payload (strategy cron kèm refreshCron); refresh gọi đúng id; delete cần 2 click.
2. **tm-page**: render entries; upsert payload; lookup render match/no-match; translate render kết quả.
3. **marketplace publish**: dialog submit đúng payload; lỗi NOT_FOUND hiển thị.
