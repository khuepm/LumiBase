---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T01:59:41.087Z
translatedFrom: en
sourceHash: f236f43b948f3ba7
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T01:59:41.087Z
codeVerifiedHash: f236f43b948f3ba7
codeVerifiedClaims: 8
---

# Runbook security advisory

Quy trình của maintainer từ một báo cáo lỗ hổng riêng tư tới một GitHub Security
Advisory (GHSA) và CVE đã công bố. Runbook thực thi
[chính sách công bố lỗ hổng](./vulnerability-disclosure.md) và dùng
[mẫu advisory](./advisory-template.md). Mục cuối ghi lại buổi chạy thử advisory
đầu tiên, đi qua mọi bước với một advisory hư cấu.

## 0. Vai trò và điều kiện tiên quyết

- **Điều phối viên advisory:** mỗi báo cáo một maintainer, có vai trò **admin**
  hoặc **security manager** trên repository (cần để sửa bản nháp, yêu cầu CVE,
  merge từ temporary private fork và công bố). Điều phối viên chịu trách nhiệm
  luồng trao đổi và các mốc thời gian; người khác có thể viết bản sửa.
- **Cài đặt repository** (Settings → Code security), kiểm tra mỗi quý và trước
  khi dựa vào runbook này: **Private vulnerability reporting** đang bật,
  **Dependabot alerts** đang bật, và **Security policy** hiển thị `SECURITY.md`.
- Trang chọn loại issue (`.github/ISSUE_TEMPLATE/config.yml`) có liên kết tới form
  báo cáo riêng tư, để không ai phải mở issue công khai mới tìm được nó.
- Không bao giờ bàn về lỗ hổng chưa công bố trong issue công khai, pull request,
  commit message, tên branch, log CI hay kênh chat. Commit message của bản sửa
  mô tả thay đổi một cách trung tính ("tighten site scope on export"), không mô
  tả cách khai thác.

## 1. Tiếp nhận và xác nhận

1. GitHub thông báo cho admin và security manager khi có báo cáo riêng tư mới.
   Maintainer đầu tiên thấy nó tự nhận làm điều phối viên trong luồng.
2. Trong vòng **3 ngày làm việc**, đăng tin trả lời xác nhận theo mẫu.
3. Nếu báo cáo tới qua đường khác (email, issue công khai), hãy chuyển nó: xoá
   hoặc ẩn chi tiết công khai, tự mở một bản nháp advisory (Security → Advisories
   → **New draft security advisory**), dán báo cáo vào, và thêm người báo cáo làm
   collaborator.

## 2. Triage

Trong vòng **7 ngày làm việc** sau khi báo cáo đầy đủ:

1. **Kiểm tra độ đầy đủ** theo chính sách §1 và §8. Nếu thiếu PoC hoặc PoC không
   tái hiện được, đăng tin trả lời "needs PoC" và đặt nhắc nhở 14 ngày. Nếu báo
   cáo nêu code không tồn tại, hoặc là output scanner/LLM, đóng nó bằng tin trả
   lời tương ứng (§10).
2. **Tái hiện** trên phiên bản được báo cáo và trên bản release mới nhất của mỗi
   major được hỗ trợ (chính sách §2), từ một bản cài sạch. Giới hạn khoảng 30
   phút trước khi hỏi thêm người báo cáo.
3. **Quyết định phạm vi** theo chính sách §3. Ngoài phạm vi nhưng là bug thật:
   cảm ơn người báo cáo, đóng bản nháp, và chỉ mở issue công khai thông thường
   nếu nó không tiết lộ điều gì khai thác được.
4. **Chấm mức độ** bằng bộ tính CVSS trong bản nháp, áp dụng mức sàn ở chính
   sách §4. Ghi vector vào bản nháp.
5. **Tìm phiên bản bị ảnh hưởng:** bản release đầu tiên chứa lỗi và mọi dòng được
   hỗ trợ mà lỗi chạm tới. Điền các khoảng phiên bản bị ảnh hưởng vào bản nháp.
6. Đăng tin trả lời triage với mức độ, phiên bản bị ảnh hưởng và ngày mục tiêu
   theo chính sách §5.

## 3. Điều phối

- Giữ mọi trao đổi trong luồng bản nháp advisory.
- Hỏi người báo cáo muốn được ghi công thế nào, và thêm họ vào phần credits của
  bản nháp.
- Ghi lại thời điểm hết embargo: ngày release mục tiêu, và tối đa 90 ngày sau
  báo cáo. Nếu sắp trễ, xin người báo cáo gia hạn trong luồng trước khi hết hạn,
  kèm lý do và ngày mới.

## 4. Sửa lỗi trong temporary private fork

1. Trong bản nháp, chọn **Start a temporary private fork**. Chỉ làm việc ở đó
   (hoặc trong một branch local chỉ được push lên đó) cho tới khi công bố.
2. Viết bản sửa kèm một **test hồi quy** thất bại trước bản sửa và qua sau bản sửa.
   Bản sửa lỗi xuyên tenant làm theo [kiểm thử IDOR](./idor-testing.md).
3. GitHub Actions không chạy trong temporary private fork, nên hãy chạy các cổng
   kiểm tra ở local trước khi review:

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

4. Review: ít nhất một maintainer khác ngoài tác giả. Người báo cáo có thể review
   nếu được mời.
5. Chưa merge. Việc merge diễn ra lúc release (§8).

## 5. Backport

Với mỗi major được hỗ trợ khác nằm trong khoảng bị ảnh hưởng (hiện nay: `1.0.x`
tới 2027-05-10), mở một pull request thứ hai trong private fork, áp dụng bản sửa
lên tag mới nhất của dòng đó, với cùng test hồi quy. Nếu không backport an toàn
được, ghi rõ trong advisory và đưa ra cách giảm thiểu.

## 6. Yêu cầu CVE

Với mức Medium trở lên (chính sách §6), khi mức độ và phiên bản bị ảnh hưởng đã
chốt: trong bản nháp, chọn **Request CVE**. GitHub review yêu cầu và gán một ID
vào bản nháp; ID vẫn riêng tư cho tới khi công bố. Nếu GitHub yêu cầu chỉnh sửa,
sửa bản nháp rồi yêu cầu lại. Không công bố khi yêu cầu còn đang chờ, trừ khi
embargo buộc phải làm vậy; CVE có thể thêm sau khi công bố.

## 7. Chuẩn bị nội dung advisory

1. Điền phần mô tả advisory theo mẫu: Summary, Affected versions, Impact, Patches
   (với số phiên bản bạn sẽ phát hành), Workarounds, Detection, References,
   Credits. Không đưa PoC vào (chính sách §7).
2. Chuẩn bị dòng `### Security` trong `CHANGELOG.md` cho từng bản release và dòng
   cho bảng chỉ mục advisory. Chúng sẽ công khai cùng bản release, nên đừng đưa
   chúng lên branch công khai trước thời điểm đó.
3. Nhờ người báo cáo review nội dung.

## 8. Phát hành và công bố

Làm các bước này vào ngày release, theo đúng thứ tự, không để cách quãng lâu:

1. Trong bản nháp, **Merge** các pull request của private fork. Bước này đưa bản
   sửa vào `main` (và bản backport vào dòng bảo trì của nó).
2. Cắt một bản patch cho mỗi dòng bị ảnh hưởng theo quy trình release thông
   thường: tăng phiên bản, thêm entry `CHANGELOG.md` với mục `### Security`, và
   điền mục `## Security` của `.github/RELEASE_TEMPLATE.md`. Push tag `vX.Y.Z` sẽ
   chạy `.github/workflows/release.yml`, workflow build, scan, ký và công bố
   Docker image, Worker, Pages và các package npm.
3. Chờ workflow release chạy xong và kiểm tra tag image và phiên bản npm nêu trong
   advisory đã tồn tại.
4. **Publish** advisory. Nếu đã được cấp CVE, CVE được công bố cùng lúc.
5. Nếu bản release làm thay đổi các phiên bản được hỗ trợ (một major mới), cập
   nhật bảng phiên bản được hỗ trợ trong `SECURITY.md` và chính sách §2 trong cùng
   bản release.

## 9. Sau khi công bố

1. Đăng tin trả lời "published" trong luồng advisory.
2. Trong một pull request công khai, thêm dòng vào
   [bảng chỉ mục advisory](./advisories.md#advisory-đã-công-bố) (cả hai locale) và
   gắn liên kết GHSA vào dòng `CHANGELOG.md` nếu dòng đó được viết trước khi có ID.
3. Công bố chi tiết proof of concept trong vòng 14 ngày, nếu người báo cáo hoặc
   nhóm muốn công khai.
4. Nếu bug thuộc một loại điểm yếu mới, thêm nó vào
   [audit CWE](./cwe-top-100-audit.md) hoặc [audit OWASP API](./owasp-api-top-10-audit.md)
   kèm biện pháp kiểm soát hiện ngăn chặn nó.
5. Xoá temporary private fork nếu GitHub chưa xoá.

## 10. Đóng báo cáo mà không có advisory

- **Không tái hiện được, không có PoC sau 14 ngày**, **nêu code không tồn tại**,
  **output scanner hoặc LLM**, hoặc **ngoài phạm vi:** đăng tin trả lời theo mẫu
  tương ứng, rồi **Close** bản nháp advisory. Không có gì được công bố.
- **Trùng lặp:** đóng kèm chỉ dẫn tới trạng thái của báo cáo trước, và ghi công
  cả hai người báo cáo nếu cả hai đều hợp lệ.
- Bản nháp đã đóng có thể mở lại khi có PoC chạy được.

## Chạy thử advisory đầu tiên

> **CHẠY THỬ — HƯ CẤU.** Mọi thứ trong mục này là bài tập. Advisory
> `GHSA-TEST-DRY0-RUN0`, người báo cáo "Test Reporter", các phiên bản
> `2.0.1-dryrun` và `1.0.2-dryrun` cùng lỗ hổng đều không tồn tại. Không có gì
> được tạo trên GitHub: không bản nháp advisory, private fork, yêu cầu CVE, bản
> release hay tag nào. Mục đích là đi qua từng bước trên giấy với repository thật
> và tìm ra những gì còn thiếu trước khi có báo cáo thật.

**Ngày:** 2026-11-14. **Kịch bản:** một báo cáo hư cấu rằng editor đã xác thực trên
một site có thể đọc item của site khác qua một đường export, trên `v2.0.0`.

| Bước | Buổi chạy thử đã làm gì | Kết quả |
|------|-------------------------|---------|
| 0. Điều kiện tiên quyết | Kiểm tra repository có security policy, lối vào báo cáo riêng tư và Dependabot. | `SECURITY.md` đã có nhưng bảng phiên bản được hỗ trợ vẫn mô tả `0.x` trong khi `2.0.0` là bản hiện hành: **đã sửa** trong thay đổi này. Trang chọn loại issue chưa có liên kết bảo mật: **đã thêm** vào `.github/ISSUE_TEMPLATE/config.yml`. **Private vulnerability reporting** có đang bật hay không là cài đặt repository, không đọc được từ code: **owner cần xác nhận** trong Settings → Code security. Dependabot được cấu hình trong `.github/dependabot.yml`. |
| 1. Tiếp nhận | Viết tin trả lời xác nhận theo mẫu cho báo cáo hư cấu. | Mẫu đủ dùng. |
| 2. Triage | Chấm điểm bug hư cấu: qua mạng, độ phức tạp thấp, đặc quyền thấp (editor), không cần tương tác, tác động bảo mật thông tin cao. Áp dụng mức sàn cô lập tenant. | **High.** Bị ảnh hưởng `>= 2.0.0, < 2.0.1-dryrun` và dòng `1.0.x`. Mức sàn CVSS ở chính sách §4 quyết định trường hợp này mà không cần tranh luận. |
| 3. Điều phối | Lên kế hoạch embargo: release mục tiêu 30 ngày sau triage (High), nằm gọn trong 90 ngày. | Không có khoảng trống. |
| 4. Private fork | Đi qua quy trình fork trên giấy. | Actions không chạy trong temporary private fork, nên runbook giờ liệt kê các lệnh kiểm tra local (§4). |
| 5. Backport | Kiểm tra `1.0.x` còn được hỗ trợ. | Còn, tới 2027-05-10. Không có branch `1.0.x` lâu dài: backport bắt đầu từ tag `v1.0.*` mới nhất (§5). |
| 6. CVE | Đi qua bước yêu cầu trên giấy; không gửi yêu cầu nào. | Áp dụng quy tắc từ Medium trở lên; High được cấp CVE. |
| 7. Nội dung advisory | Điền mẫu cho `GHSA-TEST-DRY0-RUN0` (không lưu ở đâu). | CMS không phải package npm, nên ecosystem là `Other` và không có cảnh báo Dependabot; đã ghi chú trong mẫu và trên trang advisory. |
| 8. Release | Đi qua thứ tự release theo `.github/workflows/release.yml` (tag → verify → image gate → publish). | Mẫu release notes chưa có chỗ cho bản sửa bảo mật: **đã thêm** mục `## Security` vào `.github/RELEASE_TEMPLATE.md` và nhóm nhãn `security` vào `.github/release.yml`. |
| 9. Sau khi công bố | Soạn (không commit) dòng chỉ mục và tin trả lời "published". | Trang advisory giờ có bảng chỉ mục để nhận dòng đó. |
| 10. Đóng báo cáo | Tập dượt việc đóng "nêu code không tồn tại" cho một báo cáo hư cấu thứ hai nhắc tới một file không tồn tại. | Chính sách §8 và tin trả lời mẫu đã bao quát. |

**Việc còn mở cho owner** sau buổi chạy thử: xác nhận private vulnerability
reporting đã bật trong cài đặt repository; quyết định ai mặc định làm điều phối
viên advisory.

Báo cáo thật tiếp theo làm theo §1–§10; khi có advisory đầu tiên được công bố,
thay mục này bằng một liên kết tới advisory đó.
