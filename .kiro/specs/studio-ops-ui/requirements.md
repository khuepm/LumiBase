# Requirements Document — Studio Ops UI

## Introduction

Spec đóng các gap "backend có API, Studio không có UI" NGOÀI phạm vi Content OS, phát hiện khi rà soát 2026-06-13 (đối chiếu route CMS ↔ lời gọi `api/v1` trong Studio): materialized collections, translation memory, marketplace publish. Phạm vi **UI-only** — không endpoint backend mới.

## Glossary

- **Materialization**: Bảng vật lý `mat_<target>` denormalize từ một collection nguồn, refresh theo strategy `auto`/`cron`/`manual` (`/api/v1/materialize`).
- **TM_Entry**: Một cặp dịch (sourceLang/targetLang/sourceText/targetText, quality, source human|mt|imported) trong bảng translation memory (`/api/v1/tm`).
- **Publish_Listing**: Bản ghi extension được đăng lên marketplace catalog qua `POST /api/v1/marketplace/publish` (slug, publisher, chữ ký ed25519/rsa-pss, sha256 bundle).

## Requirements

### Requirement 1: Materialize manager

**User Story:** Là một quản trị viên, tôi muốn xem/tạo/refresh/xoá materialization từ Settings, để tối ưu truy vấn đọc nặng mà không phải gọi API tay.

#### Acceptance Criteria

1. THE Settings SHALL có trang "Materialized views" liệt kê materializations từ `GET /api/v1/materialize`: collection nguồn, target, refreshStrategy (+cron nếu có), lastRefreshAt/trạng thái nếu backend trả.
2. THE trang SHALL có form tạo mới: collection (chọn từ schema API), target (pattern `^[a-z][a-z0-9_]{0,62}$`), refreshStrategy (`auto`/`cron`/`manual`; cron input khi chọn cron), projection fields (mặc định `*`) → `POST /api/v1/materialize`; lỗi backend hiển thị tại chỗ.
3. Mỗi row SHALL có nút "Refresh now" → `POST /api/v1/materialize/:id/refresh` với trạng thái busy per-row.
4. WHEN xoá materialization, THE trang SHALL confirm 2 bước → `DELETE /api/v1/materialize/:id` (drop bảng vật lý — hành động không revert được).

### Requirement 2: Translation Memory manager

**User Story:** Là một biên tập viên đa ngôn ngữ, tôi muốn quản lý translation memory và thử pipeline dịch ngay trong module Translations, để xây dựng bộ nhớ dịch mà không cần gọi API tay.

#### Acceptance Criteria

1. THE Translations module SHALL có màn "Translation memory" liệt kê TM_Entry từ `GET /api/v1/tm` với filter source/target lang; hiển thị sourceText/targetText/quality/source/provider.
2. THE màn SHALL có form thêm entry (sourceLang/targetLang/sourceText/targetText bắt buộc; context/quality optional) → `POST /api/v1/tm`.
3. THE màn SHALL có khối "Lookup" thử fuzzy match: query + cặp ngôn ngữ (+threshold optional) → `POST /api/v1/tm/lookup`; render match (text + score) hoặc "no match".
4. THE màn SHALL có khối "Translate" thử pipeline đầy đủ: text + from/to (+provider optional) → `POST /api/v1/tm/translate`; render kết quả + nguồn (tm-hit/glossary/provider) theo response.

### Requirement 3: Marketplace publish

**User Story:** Là một nhà phát triển extension, tôi muốn đăng extension lên marketplace catalog từ trang Marketplace, để hoàn tất vòng publish không cần curl.

#### Acceptance Criteria

1. THE Marketplace page (Settings) SHALL có action "Publish extension" mở form: extension (chọn từ extensions đã cài/đăng ký của site), marketplaceSlug (pattern `^[a-z0-9-]+$`), publisher, signature, signatureAlg (`ed25519` mặc định | `rsa-pss-sha256`), publisherKeyId, bundleSha256 (64 hex) → `POST /api/v1/marketplace/publish`.
2. WHEN publish thành công, THE catalog list SHALL refresh; lỗi (VALIDATION/NOT_FOUND) hiển thị tại chỗ.
