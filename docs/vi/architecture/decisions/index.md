---
version: 6
lastUpdated: 2026-11-26T02:34:33.783Z
sourceLang: en
translatedFrom: en
sourceHash: 08c209570ccf65cc
mtEngine: manual
syncStatus: human-translated
---

# Architecture Decision Records (ADR)

LumiBase tuân theo [mẫu ADR](https://adr.github.io/) để ghi lại các quyết định kiến trúc quan trọng. Mỗi ADR nắm bắt bối cảnh, quyết định và hệ quả theo một định dạng gọn nhẹ.

## Index

| ADR | Tiêu đề | Trạng thái |
|-----|-------|--------|
| [ADR-001](./adr-001-nanoid-over-uuid.md) | Dùng NanoID / UUIDv7 thay cho auto-increment | Accepted |
| [ADR-002](./adr-002-runtime-abstraction.md) | Lớp trừu tượng Runtime cho triển khai kép | Accepted |
| [ADR-003](./adr-003-hitl-for-dangerous-ai-skills.md) | Human-in-the-Loop cho các AI Skill nguy hiểm | Accepted |
| [ADR-004](./adr-004-tag-based-cache-invalidation.md) | Vô hiệu hóa cache dựa trên tag | Accepted |
| [ADR-005](./adr-005-hono-over-express.md) | Hono.js thay cho Express/Elysia | Accepted |
| [ADR-006](./adr-006-drizzle-over-prisma.md) | Drizzle ORM thay cho Prisma | Accepted |
| [ADR-007](./adr-007-logto-for-auth.md) | Logto cho xác thực | Accepted |
| [ADR-008](./adr-008-policy-dsl-json.md) | JSON Policy DSL cho phân quyền | Accepted |
| [ADR-009](./adr-009-graphql-yoga.md) | GraphQL Yoga với schema động trên ItemService | Accepted |
| [ADR-010](./adr-010-lumibase-table-prefix.md) | Tiền tố `lumibase_` cho toàn bộ bảng hệ thống | Accepted |
| [ADR-011](./adr-011-user-management-realms.md) | User Management Realms (kho lưu trữ đơn, realm theo phạm vi role, token audience) | Accepted |
| [ADR-012](./adr-012-remove-cdc-cache-invalidator.md) | Loại bỏ CDC CacheInvalidator (thay thế bằng xả tag tại đường dẫn ghi API) | Accepted |
| [ADR-013](./adr-013-organization-plane.md) | Organization plane (phân cấp tenant và credential phân loại theo phạm vi) | Proposed |
| [ADR-014](./adr-014-preview-bridge-threat-model.md) | Cầu nối live preview — preview token, nhúng frame và threat model của postMessage | Accepted |
| [ADR-015](./adr-015-extension-isolation.md) | Cách ly mã của extension (host ngoài process trên Node; Workers vẫn chạy trong process) | Accepted |
| [ADR-016](./adr-016-governed-retrieval.md) | Retrieval có quản trị (chọn engine dựa trên bằng chứng; PostgreSQL là source of truth, thử Meili hybrid trước) | Proposed |

## Template

Khi thêm một ADR mới, hãy dùng mẫu này:

```markdown
# ADR-NNN: Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNN

## Context
...

## Decision
...

## Consequences
...
```
