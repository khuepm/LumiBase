# Setup Impact — Upload File Controls

> **Single source of truth vẫn là `.kiro/specs/admin-setup-wizard/setup-impact.md`** (dòng #70).
> File này là đánh giá cục bộ của spec; giữ đồng bộ với Registry trung tâm theo
> DoD (`.kiro/steering/definition-of-done.md`).

## Đánh giá theo 6 câu hỏi Registry

| # | Câu hỏi | Trả lời | Diễn giải |
|---|---------|---------|-----------|
| 1 | Seed bảng/row mặc định khi khởi tạo? | **Không** | Không seed row `settings.upload_policy` — vắng row thì guard fallback env→default (ảnh/PDF/CSV/text + 10 MiB). |
| 2 | Feature flag / settings key operator cần biết? | **CÓ** | Settings key mới `upload_policy` (scope `site`) sửa qua Studio → Settings → Uploads. Env `FILE_UPLOAD_MAX_BYTES`/`FILE_UPLOAD_ALLOWED_MIME_TYPES` vẫn là fallback. |
| 3 | Policy/grant mặc định nên ở DB thay vì hardcode? | **Không** | `PUT /uploads/config` gated `requireSiteAdmin`; `/media` vẫn dựa RBAC `media:create` (default-deny) sẵn có. |
| 4 | Cần bước UI mới trong Setup Wizard? | **Không** | Trang nằm trong Settings (sau khi đăng nhập), không phải bước wizard. |
| 5 | Cần capability flag mới trong `GET /setup/capabilities`? | **Không** | — |
| 6 | Instance đã setup cần migration/backfill? | **Không (additive)** | `upload_policy` dùng bảng `settings` (đã tồn tại); vắng row → fallback tự động. Object media cũ (content-type chỉ trong custom metadata) serve đúng nhờ fallback `obj.metadata?.contentType`. |

## Kết luận

- **Setup wizard: `n/a`** — không seed/bước wizard/backfill DB bắt buộc.
- **Registry trung tâm**: đã ghi dòng #70 (settings key `upload_policy` + endpoint + guard hardening + polyglot scan). Cập nhật lại khi triển khai task F1 (re-encode) nếu nó thêm settings/capability.
