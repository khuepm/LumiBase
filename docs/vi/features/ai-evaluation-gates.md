---
version: 1
lastUpdated: 2026-11-05T15:42:10.810Z
sourceLang: en
translatedFrom: en
sourceHash: e59720ec7277c668
mtEngine: manual
syncStatus: human-translated
---

# Các cổng đánh giá AI (#585)

Danh mục bộ kiểm tra có phiên bản nằm tại `apps/cms/eval/ai-audit-suites.json`, tái sử dụng dữ liệu kiểm tra phân quyền, model bị chèn lệnh, đầu ra có cấu trúc, ngân sách, quản trị và vòng sửa chữa nhiều bước. Các kiểm tra xác định và PostgreSQL chạy trên PR trong `.github/workflows/ci.yml`; chất lượng model chạy riêng theo lịch hoặc thủ công tại `.github/workflows/ai-evaluation.yml`.

## Tái lập phiên bản được kiểm tra

Checkout đúng commit của PR với cây làm việc sạch, cài bằng `pnpm install --frozen-lockfile`, rồi chạy:

```bash
pnpm -F @lumibase/cms eval:ai
# Dùng database dùng một lần: fixture có thể xóa dữ liệu dùng chung.
DATABASE_URL=postgresql://... pnpm db:migrate
DATABASE_URL=postgresql://... pnpm -F @lumibase/cms eval:ai --database
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split tune
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split heldout
pnpm -F @lumibase/cms exec tsx scripts/jev-quality-gate.ts eval/jev-benchmark/reports/v1/typesafe/report.heldout.json
```

Mỗi lần chạy giao thức dùng thư mục báo cáo mới. [Giao thức benchmark](./jev-benchmark.md) mô tả dataset đóng băng, fingerprint rubric, seed, model/provider, hash ngưỡng, số đo và lỗi từng mẫu. Báo cáo còn ghi commit và trạng thái cây làm việc; phiên bản không rõ hoặc trộn nhiều commit được nêu rõ. Commit sạch cố định prompt, schema, adapter và cấu hình mặc định. Alias model phía provider có thể đổi nên đầu vào giống nhau không bảo đảm câu trả lời giống nhau.

## Cổng kiểm tra và bằng chứng

- Nhất quán contract: validation chuẩn khớp schema công bố, trường bắt buộc/quyền của Copilot và phân loại rủi ro của harness. Tool ghi dữ liệu cần schema; ngoại lệ tạo artifact seed không lưu dữ liệu. Override trong database chỉ được thêm quyền, không được bỏ quyền gốc hay hạ rủi ro nguy hiểm của tool gốc.
- PostgreSQL: đầu vào sai không tạo run/approval/version; giảm quyền không thể tạo collection hay bỏ bước phê duyệt. Fixture G3 đọc lại item, version, drift và goal sau quy trình nhiều bước; fixture đồng thời G1 xác nhận chỉ thực thi một lần.
- Thiếu database: lệnh audit thất bại khi thiếu `DATABASE_URL`; chạy trực tiếp Vitest sẽ skip rõ ràng nếu không yêu cầu DB và thất bại nếu DB đã cấu hình không kết nối được. Không tính im lặng thành pass.
- Chất lượng thực: mỗi tập heldout VI/EN cần 60 mẫu, không có lỗi gọi provider, precision chọn lọc ít nhất 0,90 và coverage ít nhất 0,50 cho cả tag và route. Thiếu ngưỡng, dữ liệu mock hoặc commit không rõ/cây làm việc bẩn đều thất bại. Đây là ngưỡng chấp nhận đề xuất, chưa phải baseline đo được hoặc cho phép bật tự động hóa. Precision theo giao thức v1; coverage ngăn model gần như luôn từ chối vượt qua cổng.
- Workflow thực chạy hàng tuần và thủ công, bắt buộc có secret provider, giữ báo cáo/ngưỡng/kết quả từng mẫu trong 30 ngày kể cả khi chất lượng thất bại. Thiếu khóa làm bước phụ thuộc thất bại, không được tính chất lượng đạt. PR không cần provider trả phí.

Test cổng chất lượng có mẫu kiểm soát tổng hợp đạt, sau đó chủ động giảm precision và yêu cầu thất bại. Assertion quyền/schema cũng thất bại khi bỏ quyền bắt buộc hoặc contract lệch nhau. CI đầy đủ còn chạy snapshot schema MCP và kiểm tra bảo vệ DB hiện có.

## Giới hạn còn lại

Thay đổi này chưa thiết lập baseline provider thực; #548 vẫn là công việc go/no-go trên dữ liệu thật. Mẫu editorial và drift tổng hợp kiểm tra độ liên quan, chống chèn lệnh và cấu trúc câu trả lời, chưa chứng minh chất lượng truy xuất RAG hoặc tính đúng sự thật nói chung. Điều tra retrieval, routing và reliability vẫn ở #581–#584. Danh mục này tập hợp bằng chứng tái sử dụng, không tuyên bố các điều tra đó hoàn tất. Mở rộng dataset hoặc đổi ngưỡng cần thay phiên bản qua review và bằng chứng heldout mới. Xem [giới hạn benchmark](./jev-benchmark.md#limitations).
