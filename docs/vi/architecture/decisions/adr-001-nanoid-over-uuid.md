---
version: 1
lastUpdated: 2026-07-05T10:56:36.990Z
sourceLang: en
translatedFrom: en
sourceHash: 0275f7b0e36f3a46
mtEngine: claude
syncStatus: machine-translated
---

# ADR-001: Dùng NanoID / UUIDv7 thay cho Auto-increment

**Date:** 2024-01-15
**Status:** Accepted

## Context

LumiBase là một nền tảng SaaS đa tenant, trong đó:

1. **Nhiều site dùng chung một cơ sở dữ liệu** — nếu các collection thuộc các site khác nhau đều dùng ID auto-increment, thì một truy vấn `UNION` hoặc truy vấn xuyên site có thể để lộ dữ liệu của tenant khác thông qua tấn công liệt kê ID (kẻ tấn công đoán `id=123` để tìm bản ghi của các site khác).

2. **Triển khai edge với các worker phân tán** — Cloudflare Workers chạy tại hơn 200 trung tâm dữ liệu trên toàn cầu. Auto-increment đòi hỏi một nguồn sinh chuỗi tuần tự duy nhất có thẩm quyền; với connection pooling qua Hyperdrive, việc sinh chuỗi tuần tự gây tranh chấp và độ trễ.

3. **Xuất/nhập Config-as-Code** — khi xuất config của một collection (schema, dữ liệu mẫu, phân quyền) ra YAML/JSON cho GitOps, các bản ghi cần ID ổn định, có thể mang đi được và không xung đột khi nhập vào một môi trường khác.

4. **Tương thích với Directus** — Directus dùng UUID cho các bảng hệ thống. LumiBase hướng tới khả năng tương thích khi migration.

## Decision

Toàn bộ khóa chính trong LumiBase dùng **NanoID** (chuỗi 21 ký tự an toàn cho URL, `~2.1M IDs/second` với xác suất trùng `< 1%` sau 1 tỷ ID) cho các bản ghi domain, và **UUIDv7** cho các bảng hệ thống/audit nơi thứ tự theo thời gian quan trọng.

Quy tắc:
- **NanoID** — nội dung người dùng (items, collections, fields, relations, users, files, flows, extensions)
- **UUIDv7** — các bảng hệ thống (activity, revisions, ai_approvals, ai_messages) nơi thứ tự theo thời gian bằng khóa chính là hữu ích
- **Không dùng serial/auto-increment** — ở bất kỳ đâu trong bảng domain hay bảng hệ thống

ID được sinh ở tầng ứng dụng (không phải ở cơ sở dữ liệu), dùng:
- `nanoid()` từ package `nanoid` (Node.js) hoặc shim `crypto.getRandomValues` (CF Workers)
- `uuidv7()` từ package `uuidv7`

## Consequences

**Tích cực:**
- Loại bỏ rủi ro bảo mật do liệt kê ID xuyên tenant
- Hoạt động mà không cần bộ sinh chuỗi tuần tự tập trung — tương thích với triển khai edge phân tán
- ID có thể mang đi giữa các môi trường (dev → staging → prod)
- Dễ đọc trong URL và log (NanoID: `art_Mk3qp7` so với UUID: `550e8400-e29b-41d4-a716-446655440000`)

**Tiêu cực:**
- Tốn dung lượng lưu trữ hơn một chút so với khóa chính kiểu integer (21 ký tự so với 4-8 byte)
- Không đảm bảo thứ tự theo ID (giảm thiểu: dùng `created_at` để sắp xếp)
- Ứng dụng phải tự sinh ID (không dùng được DB DEFAULT cho insert nếu không có ID tường minh)

**Trung tính:**
- Khóa ngoại là kiểu `text` trong schema Drizzle, không phải `integer` — chi phí join lớn hơn một chút (chấp nhận được ở khối lượng dữ liệu dự kiến)
