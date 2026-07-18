---
version: 1
lastUpdated: 2026-07-05T10:56:37.270Z
sourceLang: en
translatedFrom: en
sourceHash: d5c1914b1d9af5eb
mtEngine: claude
syncStatus: machine-translated
---

# ADR-009: GraphQL Yoga với Schema động trên ItemService

**Date:** 2026-06-17
**Status:** Accepted

## Context

LumiBase đã phát hành một REST API hoàn chỉnh trên Hono, và tầm nhìn của nó
định vị các consumer Delivery truy cập nội dung qua "REST/GraphQL/WS". Lộ trình
consumer SDK (`docs/en/roadmap/consumer-sdk.md`) dành sẵn một adapter
`.with(graphql())` có thể kết hợp. Cho đến nay, GraphQL vẫn chưa được hiện thực
trên cả API lẫn Studio.

Chúng ta muốn một bề mặt GraphQL cho **content items** (query + mutation) mà:

1. Chạy **edge-native** trên Cloudflare Workers cũng như Node/Docker.
2. Tái dùng — không bao giờ bỏ qua — các cơ chế quản trị đã được tích hợp sẵn trong
   `ItemService`: đa tenant (`site_id`), mặt nạ row/field phân quyền, RLS, soft-delete,
   revision/provenance, HITL pin, phát sóng realtime, và lập chỉ mục search.
3. Phản ánh **schema động, hậu thuẫn bởi JSONB** của LumiBase: collection và
   field được khai báo lúc runtime, không phải table-per-type, và khác nhau theo từng tenant.

Các phương án đã cân nhắc:

- **GraphQL Yoga + graphql-js** — nhẹ, tương thích Workers, tích hợp
  với Hono qua một fetch handler duy nhất, và hỗ trợ một schema factory theo từng request
  (cần cho schema động theo từng tenant).
- **Pothos (code-first)** — tuyệt vời cho schema *tĩnh*, nhưng schema của LumiBase
  được dựng lúc runtime từ `collections/fields`, nên việc dựng kiểu lúc biên dịch
  của Pothos không phù hợp.
- **Apollo Server** — nặng hơn, ít tối ưu cho runtime edge của Workers.

## Decision

Áp dụng **GraphQL Yoga + graphql-js**, gắn bên trong sub-app Hono `/api/v1`
đã xác thực tại `/api/v1/graphql`.

- **Bảo mật kế thừa:** vì route nằm dưới cùng chuỗi
  `withTenant → withDb → withAuth → … → withRls` như REST, GraphQL được
  giải quyết tenant, xác thực và RLS miễn phí.
- **Resolver mỏng:** mọi resolver ủy quyền cho `ItemService`
  (`apps/cms/src/services/item-service.ts`). Không resolver nào chạm trực tiếp vào cơ sở dữ liệu,
  nên toàn bộ quản trị được kế thừa (các quy tắc bất di bất dịch #2, #4, #5).
- **Schema động:** `buildSiteSchema()` đọc manifest `collections/fields`
  theo từng site qua `SchemaService` và dựng một `GraphQLSchema` theo lập trình
  (một object type cho mỗi collection; `Query.<collection>`,
  `Query.<collection>_by_id`; `Mutation.create_/update_/delete_<collection>`).
  Các đối số filter ánh xạ 1:1 lên các toán tử `ItemFilter` hiện có của `ItemService`.
- **Cache schema theo từng site:** các object `GraphQLSchema` không tuần tự hóa được, nên
  chúng được cache trong tiến trình, khóa theo `siteId` với TTL ngắn (60 giây);
  `invalidateSiteSchema(siteId)` loại bỏ một cái ngay lập tức.
- **Lỗi:** các `ItemServiceError` được ném ra được ánh xạ sang `GraphQLError` với
  `extensions.code` khớp với từ vựng lỗi REST, nên client xử lý
  lỗi giống hệt trên mọi bề mặt.
- **SDK:** một plugin `graphql()` có thể kết hợp (`packages/sdk/src/graphql`) thêm
  `.query()` / `.mutate()` trên nền `rawRequest` hiện có, tái dùng
  các header auth/tenant và xử lý 401 của nó.

## Consequences

**Tích cực**
- Một nguồn chân lý duy nhất cho quản trị nội dung (ItemService); GraphQL không thể
  trôi khỏi hoặc bỏ qua các quy tắc phân quyền/tenant của REST.
- Tương thích edge, bề mặt phụ thuộc tối thiểu (`graphql`, `graphql-yoga`).
- Schema tự động bám theo các thay đổi collection/field của tenant.

**Tiêu cực / đánh đổi**
- Giải quyết schema theo từng request tốn vài lần đọc manifest; được giảm thiểu bằng
  cache TTL trong tiến trình.
- Introspection theo kiểu field là nỗ lực tốt nhất: các field cấu trúc/quan hệ
  lùi về scalar `JSON` thay vì các kiểu GraphQL lồng nhau đầy đủ.

## Các mục tiếp theo đã hoàn thành

- **Gia cố:** giới hạn độ sâu truy vấn + tắt introspection trong production.
- **Quan hệ lồng nhau:** m2o/o2m được đưa ra dưới dạng field lồng nhau, giải quyết lười qua
  `ItemService` (m2m/m2a vẫn dùng lối thoát JSON).
- **Subscriptions:** `Subscription.<collection>_events` qua SSE, được bắc cầu từ
  kênh realtime của SiteRoom Durable Object.

## Công việc tương lai

- Các kiểu quan hệ lồng nhau m2m/m2a.
- Che phân quyền cấp field cho payload subscription.
- Persisted query và giới hạn chi phí truy vấn.
- Mở rộng bề mặt ra ngoài items (collections/users/admin) nếu cần.
