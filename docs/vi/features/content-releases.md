---
version: 1
lastUpdated: 2026-07-05T11:00:40.093Z
sourceLang: en
translatedFrom: en
sourceHash: a2fe3e3fa700797a
mtEngine: claude
syncStatus: machine-translated
---

# Content Releases

Một **Release** tập hợp các revision item cụ thể trên nhiều collection vào một
bundle có tên, để xuất bản tất cả cùng một lúc — thủ công, hoặc theo lịch cho một ngày/giờ. Điều này
phản chiếu Directus Releases, được xây trên mô hình items/revisions hiện có của LumiBase
và queue content-scheduler.

## Vòng đời

1. **Tạo** một release (`POST /api/v1/releases`). Không có `publishAt` thì nó bắt đầu ở
   `draft`; với một `publishAt` trong tương lai thì nó bắt đầu ở `scheduled`.
2. **Thêm item trên nhiều collection** (`PATCH …` với `addItems`). Mỗi mục là
   `{ collection, itemId, targetStatus?, revisionId? }`. Ghim `revisionId` để
   nắm bắt một phiên bản *cụ thể* của item; bỏ qua nó để xuất bản trạng thái live
   của item tại thời điểm xuất bản.
3. **Xuất bản** — hoặc ngay bây giờ (`POST /api/v1/releases/:id/publish`) hoặc
   tự động khi một release theo lịch đến hạn (được xử lý bởi tick
   `content-scheduler` dùng chung).
4. Mỗi item nhận một **kết quả theo từng item** (`published` | `skipped` | `failed`),
   và release kết thúc ở `published`, `partially_failed`, hoặc `failed`.

## Tính nguyên tử (Atomicity)

- **`all_or_nothing`** (mặc định): một lượt pre-flight kiểm tra mọi item đều
  xuất bản được (tồn tại, chưa bị xóa, cổng biên tập có thể thỏa mãn). Nếu bất kỳ item nào bị
  chặn, **không có gì** được xuất bản và release được đánh dấu `failed` kèm một
  lý do.
- **`best_effort`**: mỗi item xuất bản độc lập; release ghi lại một
  kết quả theo từng item và kết thúc ở `partially_failed` nếu một số item thất bại.

> **Phạm vi của "nguyên tử".** Tính nguyên tử được đảm bảo ở mức quyết định
> ứng dụng/xuất bản — việc xuất bản ủy quyền cho cùng đường dẫn cập nhật item được dùng bởi một
> chỉnh sửa bình thường (cổng biên tập, validate, phân quyền, hook, lập chỉ mục search).
> Việc revalidate cache/CDN diễn ra theo kiểu best-effort sau khi xuất bản và không được
> rollback.

## Lập lịch

Một release `scheduled` với `publishAt` đến hạn được xuất bản bởi `sweepDueReleases`
trên tick scheduler dùng chung. Lượt sweep là **idempotent** (một release đã xuất bản
không bao giờ bị xuất bản lại) và tôn trọng một `maintenanceWindow` tùy chọn
(`{ windows: [{ dow, start, end }] }`, UTC) — một release đến hạn nằm ngoài cửa sổ của nó
sẽ chờ tick trong-cửa-sổ tiếp theo.

## Cổng biên tập

Xuất bản một item lên `published` trên một collection có `editorialWorkflow` vẫn
đòi hỏi item đó được phê duyệt. Một release không bỏ qua khâu review — nó
xuất bản nội dung đã được phê duyệt cùng nhau. Các item chưa sẵn sàng hiện ra dưới dạng
`EDITORIAL_GATE_REQUIRED`.

## Giới hạn (v1)

- **Không có rollback cấp release.** Xóa một release loại bỏ bundle, không phải
  nội dung đã xuất bản. Lịch sử revision theo từng item vẫn còn, nên việc revert thủ công theo từng item
  vẫn khả dụng.
- **Race late-binding.** Một `release_item` không có `revisionId` xuất bản
  trạng thái live của item *tại thời điểm xuất bản* — nếu item bị chỉnh sửa giữa lúc thêm nó
  và một lần xuất bản theo lịch, chỉnh sửa sau sẽ được đưa lên. Ghim một `revisionId` trên các
  release theo lịch khi bạn cần một snapshot chính xác.
- **Chỉ con người/theo lịch.** Việc xuất bản được khởi tạo bởi một người hoặc một lịch mà một
  người đã đặt — không phải một agent skill — nên nó không đi qua `ai_approvals`.
