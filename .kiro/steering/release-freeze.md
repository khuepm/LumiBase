# Release freeze — khoá epic và tính năng mới trên `main`

> Quyết định của owner (khuepm) ngày 2026-11-20. Đang áp dụng cho **v2.2.0**
> (theo dõi ở #890). Cấu hình máy đọc: `.github/release-freeze.json`.
> Guard CI: `.github/workflows/release-freeze.yml` → `scripts/check-release-freeze.mjs`.

## Vì sao

`main` đã nhận nhiều epic hơn phạm vi #890 chọn cho v2.2.0 (phần dở của #667,
#668, #670, #671, cùng landing #885). Mỗi epic merge thêm lại kéo theo migration
mới, đánh số lại Setup Impact và vòng review mới, nên bản release không bao giờ
đứng yên đủ lâu để qua cổng GO. Từ giờ tới khi tag v2.2.0, việc duy nhất trên
`main` là **hoàn thiện phiên bản này**.

## Quy tắc

Khi `.github/release-freeze.json` có `"active": true`:

| PR vào `main` | Được merge? |
|---|---|
| `fix`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `revert` | Có |
| `chore(release)` / `release(...)` của chính phiên bản đang khoá | Có |
| `security(...)` hoặc `fix(security...)` | Có — **ngoại lệ bảo mật** |
| Có label `security` (owner gắn) | Có — ngoại lệ, kể cả khi tiêu đề là loại khác |
| `feat`, `refactor` và mọi loại không có trong danh sách trên | **Không** |
| Nhánh `epic/*`, hoặc `release(epic …)` (PR giữ chỗ của epic) | **Không** |
| Thay đổi phá vỡ (`type!:`) | **Không** — trừ khi có label `security` |
| Tiêu đề không theo conventional commit | **Không** (không phân loại được thì chặn) |

Chi tiết:

1. **Ngoại lệ bảo mật là sửa lỗi, không phải tính năng.** `feat(security)` vẫn bị
   chặn; lỗ hổng cần vá thì đặt tiêu đề `fix(security): …` hoặc `security(…): …`.
   Bản vá vẫn phải qua reviewer độc lập và DoD như mọi PR (`lane-process.md`).
2. **`fix` chỉ dùng cho lỗi thật** của thứ đã có trên `main`. Đặt tiêu đề `fix`
   cho việc thực chất là tính năng mới (hoặc để "làm nốt" một issue con chưa có
   trên `main`) là vi phạm freeze, dù guard không bắt được — reviewer từ chối.
3. **Công việc epic không dừng, chỉ không vào `main`.** Feature PR tiếp tục merge
   vào nhánh `epic/<số>-<tên>`; PR `release(epic #…)` tương ứng giữ nguyên trạng
   thái hold. Chúng được merge sau khi freeze được gỡ.
4. **Không đánh số migration mới trên `main`** trong thời gian freeze, trừ khi bản
   vá bảo mật hoặc bản sửa lỗi bắt buộc cần migration.
5. Guard đọc cấu hình và script từ **nhánh base**, nên một PR không tự gỡ freeze
   cho chính nó được.

## Phạm vi v2.2.0 đã có trên `main`

Không thêm phạm vi. Những issue con chưa xong của các epic đã nằm trên `main`
được để ở phiên bản sau, không "chạy nước rút" để làm cho kịp:

- #667: #684 page composer, phần Studio của #682.
- #668: #685, #686, #691, #694.
- #670: #704 TUS.
- #671: #709, #710, #711, #716.
- #675: #867. #677: #758.
- #869: phần còn lại sau F01 (#888, #895–#898). #888 là điều kiện của #890: nếu cần
  cho cổng GO thì owner gắn label ngoại lệ rõ ràng, ghi lý do trên #890.

## Gỡ freeze

Owner (hoặc release owner) gỡ freeze **sau khi** tag v2.2.0, bằng một PR
`chore(release): lift v2.2.0 freeze` đặt `"active": false`. Lần freeze sau chỉ cần
đổi `version`, `since`, `tracking` và bật lại `active`.

Muốn guard thật sự chặn merge: owner thêm check `release-freeze` vào required
status checks trong branch protection của `main`.
