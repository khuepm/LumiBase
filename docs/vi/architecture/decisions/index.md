---
version: 1
lastUpdated: 2026-07-05T10:56:36.955Z
sourceLang: en
translatedFrom: en
sourceHash: fa73f811c20a5c31
mtEngine: claude
syncStatus: machine-translated
---

# Bản ghi Quyết định Kiến trúc (ADR)

LumiBase tuân theo [mẫu ADR](https://adr.github.io/) để ghi lại các quyết định kiến trúc quan trọng. Mỗi ADR nắm bắt bối cảnh, quyết định và hệ quả theo một định dạng gọn nhẹ.

## Chỉ mục

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

## Mẫu

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
