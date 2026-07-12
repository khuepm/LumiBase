---
title: ClickHouse CDC
version: 1
lastUpdated: 2026-07-05T11:00:40.057Z
sourceLang: en
translatedFrom: en
sourceHash: ef8d8fe4645cd386
mtEngine: claude
syncStatus: machine-translated
---

# ClickHouse CDC

Hệ thống ClickHouse CDC (Change Data Capture) sao chép dữ liệu theo thời gian thực từ PostgreSQL (**Source_Database**) sang ClickHouse (**ClickHouse_Sink**) cho các workload OLAP/analytics, và tự động làm mới cache Redis khi các bảng cấu hình thay đổi. Nó hỗ trợ ba chiến lược sao chép có thể hoán đổi cho nhau đằng sau một interface connector chung, để bạn có thể chọn đánh đổi phù hợp cho từng pipeline.

Phần này là điểm vào cho tài liệu CDC. Hãy bắt đầu với [Tổng quan Kiến trúc](./architecture.md), rồi làm theo hướng dẫn setup cho phương án bạn đã chọn.

## Bản đồ tài liệu

| Tài liệu | Nội dung |
|----------|----------------|
| [Tổng quan Kiến trúc](./architecture.md) | Sơ đồ hệ thống, thành phần, luồng dữ liệu và topology triển khai |
| [Chọn một Phương án](#decision-criteria-choosing-an-approach) | Bảng so sánh tiêu chí quyết định (bên dưới) |
| [Setup — Debezium + Kafka](./setup-debezium-kafka.md) | Streaming thông lượng cao qua Kafka + Debezium |
| [Setup — Materialized Engine](./setup-materialized-engine.md) | Sao chép trực tiếp PostgreSQL→ClickHouse, không có message bus |
| [Setup — Airbyte](./setup-airbyte.md) | Sao chép theo lịch, được quản lý, điều khiển bằng UI/API |
| [Biến môi trường](./environment-variables.md) | Tham chiếu biến theo từng phương án + ví dụ config hoàn chỉnh hoạt động được cho mỗi phương án |
| [Xử lý sự cố](./troubleshooting.md) | Lỗi replication slot, lỗi kết nối, lỗi sync, trôi schema |
| [Triển khai — Docker Compose / dịch vụ được quản lý](./deployment-docker-compose.md) | Stack stateful đầy đủ (Kafka, Debezium, ClickHouse, Materialized Engine, Airbyte) |
| [Triển khai — Cloudflare Workers (chỉ edge)](./deployment-cloudflare-workers.md) | CDC API/control-plane + Cache_Invalidator tại edge |

## Ba phương án CDC

- **Debezium + Kafka** (`debezium_kafka`) — Debezium đọc write-ahead log (WAL) của PostgreSQL và phát các sự kiện INSERT/UPDATE/DELETE lên các topic Kafka được phân vùng theo bảng; ClickHouse nạp chúng qua Kafka table engine. Được xây dựng cho thông lượng cao nhất và độ trễ thấp nhất, với chi phí phải vận hành Kafka và Debezium.
- **ClickHouse Materialized Engine** (`materialized_engine`) — ClickHouse kết nối trực tiếp đến một replication slot của PostgreSQL bằng engine `MaterializedPostgreSQL`. Không có dịch vụ trung gian, chi phí vận hành thấp nhất, tốt nhất cho khối lượng thấp đến vừa.
- **Airbyte** (`airbyte`) — Airbyte quản lý nguồn PostgreSQL, đích ClickHouse và một kết nối theo lịch qua nền tảng của nó. Ít hạ tầng phải vận hành nhất, với các lần sync theo lịch (không streaming).

## Tiêu chí quyết định: chọn một phương án

Dùng bảng này để chọn một phương án. Các ngưỡng khớp với engine gợi ý tích hợp sẵn (`apps/cms/src/modules/cdc/recommender.ts`): khối lượng cao (> 10.000 hàng/giây) hoặc ngân sách độ trễ dưới 5 giây sẽ hướng bạn đến Debezium+Kafka; khối lượng thấp (< 5.000 hàng/giây) không có Kafka và ngân sách nới lỏng (< 30 giây) sẽ hướng bạn đến Materialized Engine; ưu tiên dịch vụ được quản lý sẽ hướng bạn đến Airbyte.

| Tiêu chí | Debezium + Kafka | Materialized Engine | Airbyte |
|----------|------------------|---------------------|---------|
| **Ngưỡng khối lượng dữ liệu (hàng/giây)** | Cao — thiết kế cho **> 10.000 hàng/giây**; các topic phân vùng hấp thụ tốc độ ghi nặng | Thấp–vừa — tốt nhất **< 5.000 hàng/giây** | Thấp–vừa — hướng batch; thông lượng bị giới hạn bởi khoảng thời gian sync |
| **Khoảng độ trễ sao chép** | Streaming: thường **< 30 giây** đầu-cuối (sự kiện được nạp trong vòng 30 giây kể từ khi phát); dưới một giây khi tải nhẹ | Gần thời gian thực: **≤ 10 giây** độ trễ trong điều kiện bình thường | Theo lịch: **5 phút – 24 giờ** (khoảng thời gian có thể cấu hình) |
| **Phụ thuộc hạ tầng** | Kafka Broker + Debezium (Kafka Connect) + ClickHouse Sink | Chỉ ClickHouse Sink (replication slot PostgreSQL trực tiếp) | Nền tảng Airbyte + ClickHouse Sink |
| **Số bước cấu hình thủ công** | **Nhiều nhất** (~8): publication, replication slot, connector Debezium, các topic Kafka, Kafka table engine, materialized view, bảng sink, đấu nối mạng | **Ít** (~3): tạo database `MaterializedPostgreSQL`, cấp quyền replication, chọn bảng | **Ít nhất** (~3): tạo source, destination và connection (điều khiển bằng UI/API) |

> Wizard pipeline của Studio đưa ra một gợi ý từ chính engine này khi bạn nhập yêu cầu khối lượng và độ trễ ước tính (Requirement 6.3).

## Chính sách cập nhật tài liệu

Theo **Requirement 9.5**, bất cứ khi nào thêm một phương án CDC hoặc tùy chọn cấu hình mới, tài liệu này **phải được cập nhật trước khi tính năng được merge vào nhánh main**, theo cùng cấu trúc dùng ở đây:

1. Một **phần kiến trúc** mô tả phương án (thêm vào [Tổng quan Kiến trúc](./architecture.md)).
2. Một **hướng dẫn setup** (`setup-<approach>.md`) phản chiếu các hướng dẫn setup hiện có.
3. Một **tham chiếu biến môi trường** cho phương án (thêm vào [Biến môi trường](./environment-variables.md)) bao gồm mô tả, giá trị mặc định và quy tắc validate, cộng với một ví dụ cấu hình hoàn chỉnh hoạt động được.
4. **Các bước triển khai** (cập nhật hướng dẫn triển khai liên quan) và một hàng trong [bảng tiêu chí quyết định](#decision-criteria-choosing-an-approach) ở trên.

Các định nghĩa biến môi trường trong tài liệu này được sinh từ, và phải nhất quán với, `apps/cms/src/modules/cdc/ai-flow/config-generator.ts`.

## Liên kết liên quan

- Kho lưu trữ dự án: [github.com/khuepm/lumibase](https://github.com/khuepm/lumibase)
- Website dự án: [lumibase.dev](https://lumibase.dev)
- Tài liệu triển khai nền tảng: [Chỉ mục Tài liệu LumiBase](../README.md)
