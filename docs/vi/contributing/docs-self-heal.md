---
title: Self-healing docs
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:50:12.145Z
translatedFrom: en
sourceHash: c645cb899aef55d3
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T16:50:12.145Z
codeVerifiedHash: c645cb899aef55d3
codeVerifiedClaims: 14
---

# Tài liệu tự chữa lành (lệch giữa doc và code)

Tài liệu của LumiBase đưa ra những khẳng định về code: một file nằm ở một đường
dẫn, một endpoint được mount, một biến môi trường được đọc, một hàm được export.
Khi code thay đổi, các khẳng định đó lặng lẽ trở nên lỗi thời — và vì EN và VI
được dịch từ nhau, cả hai locale cùng lỗi thời *một lúc*, điều mà không phép so
sánh hash nào phát hiện được.

Bộ công cụ self-heal lấp khoảng trống đó ở hai nơi:

| Ở đâu | Làm gì | Đánh trượt / ghi |
|---|---|---|
| Mọi pull request | `gate-code-drift.mjs` — tìm các doc mà PR làm lỗi thời | Đánh trượt check, kèm annotation trên đúng dòng của doc |
| Mọi lần push lên `main` (và chạy thủ công) | `self-heal.mjs` — viết lại phần lệch mang tính cơ học | Mở hoặc cập nhật một PR duy nhất trên `docs/self-heal` |

Cả hai nằm trong `scripts/docs-i18n/` và chạy trong `.github/workflows/docs-self-heal.yml`.

**Mọi thứ ở đây đều tất định.** Không gọi model, không dịch máy và không có
`ANTHROPIC_API_KEY` — cùng một quyết định của dự án như phần còn lại của bộ công
cụ docs i18n (xem [Docs i18n Sync](./docs-i18n.md)). "Chữa lành" chỉ bao giờ viết
lại code: một đường dẫn, một tên biến môi trường, một route, một định danh. Code
giống hệt nhau ở EN và VI (check cấu trúc parity bắt buộc điều đó), nên cùng một
thay đổi được áp cho cả hai locale và không có gì cần dịch.

## Cổng kiểm tra PR

Cổng này diff PR với base của nó có bật phát hiện đổi tên, rồi quyết định những
doc nào có thể đã lỗi thời. Một cặp doc được kiểm tra khi nó:

- được sửa trong PR (ở bất kỳ locale nào);
- trích dẫn một file nguồn mà PR đã sửa, di chuyển hoặc xóa (đường dẫn tính từ gốc
  repo như `apps/cms/src/index.ts`, và đường dẫn tương đối như `middleware/auth.ts`,
  được phân giải giống hệt cách verifier phân giải);
- nêu tên một biến môi trường mà PR không còn đọc nữa;
- khẳng định một route có đường dẫn dùng một segment mà PR đã gỡ bỏ; hoặc
- nêu tên, trong một code span, một symbol được export mà PR đã gỡ khỏi một file
  mà doc đó trích dẫn.

Mỗi doc được ánh xạ sẽ được kiểm tra ở head của PR **và** ở base của PR bằng
chính các check mà `stamp-pair.mjs --verified` áp dụng (`verify-code-refs.mjs`).
Chỉ những khẳng định lỗi thời ở head nhưng vẫn đúng ở base mới làm check thất bại
— tức là phần lệch do chính PR này gây ra. Phần lệch đã có sẵn trên `main` chỉ
hiện dưới dạng cảnh báo.

Một lần thất bại trỏ đúng vào dòng, trong tab "Files changed" của PR và trong log:

```text
::error file=docs/en/features/webhooks.md,line=42,title=Stale doc claim (route)::[route] /api/v1/webhooks/:id — no mount found for "webhooks". Cause: route segment "webhooks" renamed to "hooks" in apps/cms/src/index.ts. Mechanical fix available: …
```

Nguyên nhân là một trong các trường hợp: file đã chuyển sang đường dẫn mới (git
rename), file bị xóa, biến môi trường bị đổi tên hoặc không còn được đọc, segment
route bị đổi tên hoặc route bị gỡ bỏ, symbol được export bị đổi tên hoặc gỡ bỏ.

Chạy cục bộ so với `main`:

```bash
pnpm docs:i18n:drift --base origin/main
pnpm docs:i18n:drift --base origin/main --all   # every doc, not only the mapped ones
```

## Các bộ sửa tự động

`self-heal.mjs` chỉ viết lại những chỗ lệch có đúng một câu trả lời đúng:

| Loại | Ví dụ | Nguồn sự thật |
|---|---|---|
| Đường dẫn file | `src/old-name.ts` → `src/new-name.ts` | git rename, trong khoảng commit hoặc bất kỳ đâu trong lịch sử |
| Biến môi trường | `LUMIBASE_OLD` → `LUMIBASE_NEW` | một tên bị gỡ + một tên được thêm trong cùng một file nguồn |
| Route | `/api/v1/old/:id` → `/api/v1/new/:id` | một route literal bị đổi tên, khác đúng một segment, cùng method |
| Symbol được export | `oldName()` → `newName()` | một export bị gỡ + một export được thêm trong file mà doc trích dẫn |

Một lần đổi tên chỉ được coi là đổi tên khi nó không mơ hồ — hai tên bị gỡ và hai
tên được thêm có thể là hoán đổi hoặc tách đôi, và đoán mò sẽ ghi một cái tên sai
vào doc. Những trường hợp đó, cùng mọi trường hợp bị gỡ bỏ (file bị xóa, route bị
bỏ, biến môi trường đơn giản là biến mất), được liệt kê ở mục **Needs a human**:
câu văn xung quanh phải được sửa, ở cả hai locale.

Đường dẫn được viết lại ở mọi nơi chúng xuất hiện dưới dạng một đường dẫn trọn
vẹn (code span, ví dụ trong khối code, đích của liên kết). Tên biến môi trường
được viết lại theo nguyên từ. Route được viết lại ở nơi khẳng định xuất hiện.
Symbol chỉ được viết lại bên trong code span của những doc trích dẫn file đó.
Front matter không bao giờ bị động tới.

**Nguồn gốc (provenance).** Sau khi viết lại, một cặp chỉ được đóng dấu lại bằng
`stamp-pair.mjs <rel> <sourceLang> --verified` khi nó đã đồng bộ trước lúc sửa,
cả hai locale giờ kiểm tra không còn phát hiện nào, và các cổng riêng của
stamp-pair đều qua. Nếu không, phần thân được sửa nhưng provenance giữ nguyên, và
PR nói rõ lý do — một cặp đang chờ người dịch sẽ không bị đánh dấu là đã dịch.

Chạy cục bộ:

```bash
pnpm docs:i18n:heal --base origin/main --dry-run
pnpm docs:i18n:heal --base origin/main --report /tmp/heal.md
```

## PR self-heal

Mỗi lần push lên `main`, job `heal` chạy các bộ sửa. Nếu có gì thay đổi, nó
force-push kết quả lên nhánh `docs/self-heal` và mở một pull request, hoặc sửa
PR đang mở sẵn — luôn chỉ có một PR. Phần thân PR liệt kê từng chỗ sửa (doc và
dòng, giá trị cũ và mới, nguyên nhân), mọi khẳng định lỗi thời mà nó không sửa
được, và những cặp nào đã được đóng dấu lại.

- **Idempotent.** Nhánh được dựng lại từ `main` ở mỗi lần chạy. Trong khi PR còn
  mở, phần thân của nó ghi lại revision dùng làm mốc đo độ lệch, và các lần chạy
  sau dùng lại mốc đó, nên các chỗ sửa từ những lần push trước được tạo lại chứ
  không bị mất.
- **Không bao giờ tự merge.** Một người review và merge nó.
- **Tự động đóng** khi một lần chạy không còn gì để sửa.
- **Quyền tối thiểu.** Job dùng `GITHUB_TOKEN` chỉ với `contents: write` và
  `pull-requests: write`; cổng kiểm tra PR chỉ có quyền đọc.

Có hai thiết lập repository cần lưu ý. "Allow GitHub Actions to create and approve
pull requests" phải được bật thì job mới mở được PR. Và một PR được mở bằng
`GITHUB_TOKEN` không kích hoạt các workflow khác, nên CI sẽ không chạy trên nó cho
tới khi có người push lên nhánh hoặc đóng rồi mở lại PR.

## Giới hạn

- Văn xuôi nằm ngoài phạm vi. Nếu một câu mô tả hành vi đã thay đổi, không công cụ
  nào ở đây nhận ra; chỉ những khẳng định mà verifier trích xuất được mới được
  kiểm tra.
- Chỉ các dạng khẳng định mà `verify-code-refs.mjs` nhận diện được mới được kiểm
  tra (đường dẫn repo và tên biến môi trường đặt trong backtick, route ở các dạng
  nó phân tích được). Một lần nhắc tới bằng chữ thường thì nó không thấy.
- Check symbol yêu cầu doc phải trích dẫn file mà symbol đến từ đó; một định danh
  đứng một mình quá chung chung để khẳng định.
