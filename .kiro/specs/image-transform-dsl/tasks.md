# Implementation Plan: Image Transform DSL

> **Status (PR #208, 2026-07-06):** Greenfield spec largely delivered in this PR: **task 1** (`transformDslSchema`/`MAX_DIM`/`transformKey`/`parseTransformQuery`/`fileTag` in `@lumibase/shared` + tests), **task 3** (`transform_presets` table + migration `0004` + CRUD routes), **task 4** (delivery transform on `GET /media/:key` — validate DSL, delegate to runtime image URL, backward-compatible), **task 6** (SDK `mediaUrl` + Studio `TransformPanel`/`FocalPicker`/`PresetManager`), **task 2** (`MediaProcessor.transform` optional byte-transform seam + Docker Sharp impl via dynamic import; delivery route prefers in-process transform, falls back to the URL-based processor — CF Image Resizing / Imgproxy — when Sharp is absent), and **task 5** (HMAC signed transforms via Web Crypto + `media.signedTransform` policy: `presetOnly` + `?sig=` enforcement). All task groups complete. Setup Impact recorded (registry #42, migration `0004`).

## Overview

Thứ tự: DSL chung → runtime adapter → preset schema/routes → delivery transform + cache → signed/abuse → UI → chất lượng. Giữ ảnh gốc + thumbnail cũ không vỡ.

## Tasks

- [x] 1. DSL chung
  - [x] 1.1 `packages/shared/src/schemas/transform.ts`: `transformDslSchema` (Zod) + `TransformDsl` + `MAX_DIM` + `transformKey()`
    - _Requirements: 1.2, 6.1_
  - [x] 1.2 Unit test: reject quá trần/quality lạ/format lạ; transformKey ổn định theo thứ tự param
    - **Validates: Requirements 1.2, 6.1**

- [x] 2. Image adapter (runtime abstraction)
  - [x] 2.1 Thêm `ImageAdapter` interface + `image` vào runtime (`packages/runtime/src/`); CF adapter (cf.image/CF Images), Docker adapter (Sharp)
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 2.2 Fallback format khi không hỗ trợ (vd AVIF→webp) hoặc 400 rõ ràng
    - _Requirements: 2.4_
  - [x] 2.3 Test: Docker Sharp resize đúng size/format; CF adapter gọi đúng API (mock)
    - **Validates: Requirements 2.1, 2.2**

- [x] 3. Preset store + routes
  - [x] 3.1 Bảng `transformPresets` (`packages/database/src/schema/`) + migration tay + journal
    - _Requirements: 3.1_
  - [x] 3.2 `GET/POST/PATCH/DELETE /api/v1/transform-presets` filter siteId, permission, response chuẩn
    - _Requirements: 3.3_
  - [x] 3.3 Test: CRUD scope siteId; 404 cross-tenant

- [x] 4. Delivery transform + cache
  - [x] 4.1 `media.ts GET /media/:key`: parse preset|params → validate → runtime.image.transform; không param → gốc (backward-compatible)
    - _Requirements: 1.1, 1.3, 3.2_
  - [x] 4.2 Cache theo `transformKey` qua runtime.cache, tag `file:<key>`; invalidate tag khi file gốc PATCH/DELETE (ADR-004)
    - _Requirements: 1.4, 4.1, 4.2_
  - [x] 4.3 Test: transform đúng (mock adapter); cache hit lần 2; invalidate khi file đổi
    - **Validates: Requirements 1.1, 4.1, 4.2**

- [x] 5. Signed transform + abuse guard
  - [x] 5.1 HMAC sign/verify (hằng-thời-gian); settings `media.signedTransform`; trần MAX_DIM; presetOnly mode
    - _Requirements: 3.4, 4.3, 4.4_
  - [x] 5.2 Test: sig đúng pass / sai 403; presetOnly chặn custom; trần chặn upscale lớn
    - **Validates: Requirements 4.3, 4.4, 3.4**

- [x] 6. SDK + UI
  - [x] 6.1 SDK `mediaUrl(key, dsl|presetKey, {sign?})`
    - _Requirements: 6.2_
  - [x] 6.2 `transform-panel.tsx` + `focal-picker.tsx`: custom transform preview live + Copy URL; focal {x,y}
    - _Requirements: 5.2, 5.4_
  - [x] 6.3 `media-detail.tsx` + `preset-manager.tsx`: preview + preset list (Copy URL) + CRUD preset; presetOnly ẩn custom
    - _Requirements: 5.1, 5.3_
  - [x] 6.4 Component test: focal picker đặt {x,y}; mediaUrl ghép URL+sig; presetOnly ẩn custom
    - **Validates: Requirements 5.4, 6.2, 5.3**

- [x] 7. Chất lượng & Setup Impact
  - [x] 7.1 `pnpm typecheck` + `pnpm test` pass; runtime abstraction tuân thủ; cập nhật `docs/en/api/hono-api-spec.md` + `docs/en/data-model.md`
    - _Requirements: 6.4_
  - [x] 7.2 Chuyển thumbnail hardcoded → preset `thumbnail` default; ảnh cũ không vỡ
    - _Requirements: 6.3_
  - [x] 7.3 **Setup Impact** (DoD): rà soát 6 câu hỏi. Seed preset mặc định `thumbnail` khi setup (Q1) + settings key `media.signedTransform` (Q2). Migration `transformPresets` + backfill seed preset cho instance cũ (Q6) — idempotent. Thêm dòng registry sau
    - _Requirements: DoD_
