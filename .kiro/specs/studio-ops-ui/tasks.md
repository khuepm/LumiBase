# Implementation Plan: Studio Ops UI

## Overview

UI-only cho 3 gap ngoài Content OS. Mỗi task tự ship được, test theo convention module tương ứng.

## Tasks

- [x] 1. Materialize manager
  - [x] 1.1 `settings/materialize-page.tsx`: list (react-query) + form create (collection picker, target regex, strategy radio + cron input, projection fields) + Refresh now per-row + Delete confirm 2 bước; đăng ký Settings nav + routes ×2 Admin_Base
    - _Requirements: 1.1-1.4_
  - [x] 1.2 Component test: create payload (cron strategy kèm refreshCron), refresh đúng id, delete 2 bước
    - **Validates: Requirements 1.2, 1.3, 1.4**

- [x] 2. Translation Memory manager
  - [x] 2.1 `translations/tm-page.tsx`: bảng entries + filter lang pair, form upsert, khối Lookup (fuzzy) + khối Translate (pipeline); routes ×2 + link từ màn translations
    - _Requirements: 2.1-2.4_
  - [x] 2.2 Component test: upsert payload, lookup render match/no-match, translate render kết quả
    - **Validates: Requirements 2.2, 2.3, 2.4**

- [x] 3. Marketplace publish
  - [x] 3.1 `settings/marketplace-page.tsx`: nút + dialog Publish (extension select, slug/publisher/signature/alg/keyId/sha256) → POST /marketplace/publish, invalidate catalog, lỗi tại chỗ
    - _Requirements: 3.1, 3.2_
  - [x] 3.2 Component test: submit đúng payload, lỗi hiển thị
    - **Validates: Requirements 3.1, 3.2**
