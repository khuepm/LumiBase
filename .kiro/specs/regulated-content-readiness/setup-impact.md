# Setup Impact — Regulated / Sensitive Content Readiness

> **Single source of truth vẫn là `.kiro/specs/admin-setup-wizard/setup-impact.md`.** File này là đánh giá cục bộ của spec; khi mỗi phase hoàn thành, PHẢI thêm dòng tương ứng vào Registry trung tâm (đã có task `tasks.md` #13) và cập nhật docs theo DoD (`.kiro/steering/definition-of-done.md`).

## Đánh giá theo 6 câu hỏi Registry

| # | Câu hỏi | Trả lời | Diễn giải |
|---|---------|---------|-----------|
| 1 | Seed bảng/row mặc định khi khởi tạo? | **Không bắt buộc** | `encryption_keys`: không cần seed — KeyProvider fallback `keyId='v0'` từ `ENCRYPTION_KEY` (Req 4.4). `content_reviews`/`erasure_requests`/`field_access_log` rỗng lúc khởi tạo. Settings mới vắng row = mặc định off. |
| 2 | Feature flag / settings key operator cần biết? | **CÓ** | Opt-in keys: `encryption.envelope`, `encryption.activeKeyId`; per-collection `editorialWorkflow`, `requireSeparateReviewer`, `degradedReadOnFailure`, `unpublishTarget`; `retention.policies[]`; `erasureDualControl`; `seo.jsonLdType`. Tất cả mặc định off/absent → hành vi Tier 1 không đổi (Req 16.5). Phải tài liệu hoá trong docs. |
| 3 | Policy/grant mặc định nên ở DB thay vì hardcode? | **Không** | Retention policy: absence = không retention (an toàn). Không có default policy cần seed. |
| 4 | Cần bước UI mới trong Setup Wizard? | **Không** | Các năng lực cấu hình **sau** setup (data-model classification, editorial settings, retention, key rotation qua admin API/Studio). Không thêm bước wizard. |
| 5 | Cần capability flag mới trong `GET /setup/capabilities`? | **Tuỳ chọn** | Có thể thêm `keyProviderConfigured` / `envelopeEncryption` để Studio cảnh báo cấu hình khoá ở production. Không bắt buộc cho luồng setup; quyết định khi triển khai Phase A. |
| 6 | Instance đã setup cần migration/backfill? | **Không (additive)** | Mọi cột mới nullable/có default; guard `IF NOT EXISTS` (Req 16.4). Ciphertext cũ đọc qua `v0` (Req 3.2). **Ngoại lệ vận hành (không phải backfill DB):** khi bật envelope encryption *sau này*, ciphertext cũ vẫn ở chế độ single-key `v0` cho tới khi chạy rewrap worker (Req 3.6) — đây là tác vụ tuỳ chọn, không bắt buộc, không chặn nâng cấp. |

## Kết luận

- **Setup wizard hiện tại: `n/a`** — spec không yêu cầu seed/bước wizard/backfill DB bắt buộc.
- **Cần ghi Registry trung tâm** khi triển khai: tối thiểu 1 dòng cho cụm "regulated-content-readiness" mô tả nhóm settings opt-in (câu 2) và (nếu chọn) capability flag (câu 5).
- Docs cần cập nhật khi triển khai: hướng dẫn cấu hình KeyProvider/rotation, classification, editorial workflow, retention, erasure/SAR; và `docs/en/api/hono-api-spec.md` cho endpoint admin mới (`/encryption/keys/rotate`, `/erasure`, `/sar/export`).
