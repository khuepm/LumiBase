# Quy trình làm việc — một implementer, một reviewer

> Thay thế toàn bộ mô hình lane A/B/C, handoff-ACK-theo-phiên và exact-file-grant-theo-pha
> đã dùng cho #331/#453/#454/#455/#472. Quyết định của owner (khuepm) ngày 2026-09-19.
>
> Vì sao đổi: mô hình cũ chặn tiến độ ở chỗ **không ai được phép tiếp tục**. Đã có ba
> lần công việc đứng lại chỉ vì thiếu một dòng ACK, thiếu một grant, hoặc thiếu người
> nhận lane — trong khi bản thân công việc đã rõ và đã có bằng chứng. Mô hình mới giữ
> đúng **một** hàng rào thật (reviewer độc lập) và bỏ phần còn lại.

## Hai vai, và chỉ hai

| Vai | Ai làm | Gắn với phiên cụ thể? |
|---|---|---|
| **Implementer** | bất kỳ người/phiên nào **trừ** reviewer | **Không** |
| **Reviewer** | một vai riêng, độc lập | Có — phải khác implementer |

## Quy tắc

1. **Bất kỳ ai cũng tiếp tục được việc của implementer.** Không cần handoff, không cần
   session ACK, không cần chờ gán owner. Thấy việc đang dở thì làm tiếp.
2. **Không còn lane A/B/C** và không còn luật "mỗi lane một work item".
3. **Không còn exact-file grant theo pha.** Implementer sửa file nào cần thì sửa, kể cả
   production, shared contracts, manifest, docs — miễn là nằm trong phạm vi issue đang làm.
4. **Reviewer là hàng rào duy nhất còn lại.** Người đang làm implementer cho một hạng mục
   **không được** tự review hoặc tự nghiệm thu đúng hạng mục đó. Đây là lý do duy nhất
   quy trình này còn tồn tại — đừng bỏ.
5. **Một PR duy nhất** cho các hạng mục đang chạy song song, thay vì một PR mỗi lane.
6. Giữ nguyên các giới hạn an toàn: **không** push thẳng `main`, **không** tự merge PR của
   chính mình, **không** tự đóng issue, **không** release/deploy. Merge và đóng issue là
   việc của owner sau khi reviewer ra verdict.

## Điều KHÔNG đổi

- **Definition of Done** (`definition-of-done.md`) vẫn áp dụng đầy đủ.
- **Reviewer vẫn ra verdict** `accepted` / `changes required` / `blocked`, và verdict đó
  vẫn là điều kiện để merge.
- **Không được suy** `CI xanh` hoặc `đã merge` thành `đã nghiệm thu`. Hai thứ đó độc lập.
- Quy ước commit, nhánh (`feature/<issue>-<description>`), và log out-of-scope findings
  (`out-of-scope-backlog.md`) giữ nguyên.

## Hệ quả cho các issue đang mở

- **#453 (G1)** — đã ACCEPTED tại `6717182b` (hồ sơ trong `docs/review-agent/`). Gate gỡ.
- **#454 (G2)** — implementer tiếp tục được ngay, không chờ grant.
- **#472 (G2-CAP)** — bất kỳ ai nhận cũng được; vẫn là dependency của phần bật governed
  transport, nhưng **không** còn cần dispatch riêng.
- **#455 (G3)** — như trên.
