---
version: 3
lastUpdated: 2026-11-21T00:28:04.283Z
sourceLang: en
translatedFrom: en
sourceHash: caac29248d95f271
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-21T00:28:04.283Z
codeVerifiedHash: caac29248d95f271
codeVerifiedClaims: 16
---

# Chèn nội dung và SEO poisoning: hướng dẫn cho người vận hành

Tháng 11/2026, FBI phát hành FLASH CC-111626-MW về Gootloader: hơn 1.000 site
WordPress, bị xâm nhập bằng thông tin đăng nhập bị đánh cắp, vẫn chạy bình
thường với chủ site trong khi phục vụ trang mồi cho một số người truy cập được
chọn — một file ZIP chứa JavaScript mở đường cho ransomware. Cách kiểm tra quen
thuộc của chủ site (mở site, đọc bài mới nhất) không thấy gì.

LumiBase không phải WordPress — không có PHP, không có `xmlrpc.php`, không có
form bình luận công khai, và CMS trả về JSON chứ không phải trang. Nhưng mô
thức thì chung: **một credential hợp lệ, rồi chèn nội dung lặng lẽ mà không ai
nhận ra**. Hướng dẫn này nói LumiBase làm gì với nó, bạn cấu hình gì, phần nào
vẫn là việc của frontend, và phải làm gì vào ngày có điều bất thường.

## 1. LumiBase bao phủ gì, và không bao phủ gì

| Lĩnh vực | LumiBase | Frontend / CDN của bạn |
| --- | --- | --- |
| Ai đăng nhập được, và bằng gì | MFA, khoá tài khoản, session, API key | — |
| Ai được đổi nội dung, trang, mã | Permission, mức autonomy, phê duyệt | — |
| Bản ghi mọi thay đổi quản trị | Dòng audit `admin_change` | — |
| Nội dung đáng ngờ được đưa lên live | Bộ giám sát toàn vẹn nội dung | — |
| Người truy cập hay crawler nhận được gì | Chỉ JSON; không response nào thay đổi theo User-Agent, referrer hay quốc gia | **Của bạn**: render, redirect, edge rule, Workers, cloaking |
| Góc nhìn của công cụ tìm kiếm về site | — | **Của bạn**: Search Console và công cụ webmaster |

## 2. Checklist gia cố

Ánh xạ theo bảng biện pháp kiểm soát trong FLASH:

| Biện pháp trong FLASH | Trong LumiBase |
| --- | --- |
| Bảo vệ quyền quản trị (MFA chống lừa đảo) | Cờ policy `enforceTfa` trên các policy admin và editor — nay có hiệu lực trên mọi route, từ mọi client; ưu tiên passkey. Xem [Quản lý người dùng](./user-management.md) §4f. |
| Thu hẹp bề mặt tấn công | Đóng đăng ký tự phục vụ nếu bạn không có khán giả công khai (setting của site `auth.registration` = `{ "enabled": false }`). Xem `GET /api/v1/api-keys/unused?days=90` và thu hồi những gì không ai dùng; key mới hết hạn sau 90 ngày trừ khi bạn chỉ định khác. Giữ cổng setup bật (mặc định ở production). |
| Đặc quyền tối thiểu | Chỉ cấp `lumibase_pages` cho người sửa trang; giới hạn bằng rule theo dòng. Giữ extension và API key cho admin. Agent không thể cài extension, tạo key, hay đổi setting, role hoặc webhook mà không có người, ở mọi mức autonomy. |
| Giám sát toàn vẹn | Lọc tab audit bảo mật theo `admin_change` (ai đổi gì, từ đâu) và `content_integrity_alert` (nội dung đáng ngờ đã lên live). |
| Kiểm soát upload file | Giữ `FILE_UPLOAD_ALLOWED_MIME_TYPES` trong catalogue; mặc định không upload được file nén và script. |
| Vá lỗi và thành phần tin cậy | Extension chỉ nạp từ `EXTENSION_BUNDLE_ORIGINS` với chữ ký hợp lệ; đổi bundle sẽ được kiểm lại. Trên Node ở production, mỗi extension chạy trong process riêng, không có secret của CMS (`EXTENSION_RUNTIME`, [ADR-015](../architecture/decisions/adr-015-extension-isolation.md)). |
| Tập trung bằng chứng | Xuất audit log (`GET /api/v1/admin/security/audit-log/export`) ra nơi lưu trữ ngoài CMS. |

Chạy `lumibase doctor --security` với môi trường production của bạn; lệnh này
báo cáo cổng setup, các tuỳ chọn mở rộng loại upload và phần còn lại của
[mặc định an toàn](./secure-defaults.md).

Bật hành động `unpublish` của bộ giám sát toàn vẹn nội dung cho những site mà
một cảnh báo nhầm rẻ hơn một trang mồi đang live:

```json
{ "key": "contentIntegrity", "value": { "action": "unpublish", "allowedHosts": ["cdn.example.com"] } }
```

(`POST /api/v1/settings` với quyền site admin.) Xem
[Toàn vẹn nội dung](./content-integrity.md).

## 3. Checklist cho frontend và CDN

Các trang mà công cụ tìm kiếm index do frontend của bạn render. Hãy kiểm tra,
ít nhất hằng tháng và sau mỗi sự cố:

- **Truy vấn trong Search Console.** Tìm các cụm từ không liên quan tới site —
  cụm từ pháp lý, "định nghĩa …", cá cược, thuốc. FLASH liệt kê các cụm từ mồi
  như "Zoning Government Definition" và "When did Sports Betting Become Legal in
  Virginia". Truy vấn không liên quan nghĩa là bạn đang xếp hạng cho nội dung
  mình không đăng.
- **Trang được index.** Số URL được index tăng đột ngột, hoặc có URL không nằm
  trong sitemap, là cùng một tín hiệu.
- **Crawler và trình duyệt.** Tải vài trang bằng User-Agent của công cụ tìm kiếm
  và bằng trình duyệt thường, từ một mạng sạch, rồi so sánh. Mọi khác biệt là
  cloaking ở đâu đó giữa LumiBase và người truy cập.
- **Kiểm kê edge.** Liệt kê các rule của CDN, redirect, Workers / edge function
  và lịch sử deploy của chúng. Kẻ tấn công không chạm được vào CMS vẫn có thể
  thêm một rule ở đây.
- **Credential build và deploy.** Deploy hook, build token và tích hợp git có
  thể đổi những gì frontend phục vụ; hãy xoay chúng cùng với credential của CMS
  (§5).
- **Sitemap chỉ từ item đã xuất bản.** Sinh nó từ deliver API, để trong đó không
  có gì mà LumiBase không phục vụ ở trạng thái đã xuất bản.

### Render nội dung an toàn (Next.js starter và các frontend khác)

- Render rich text từ đầu ra đã được làm sạch của API (GraphQL `RichText.html`,
  bộ làm sạch theo allowlist) hoặc từ tài liệu JSON — không bao giờ đưa một field
  chuỗi thường qua `dangerouslySetInnerHTML`.
- Coi block `_seo` của deliver API là dữ liệu: trước khi đưa `canonical` hay
  `openGraph.url` vào thẻ `<link>` hoặc `<meta>`, hãy kiểm tra host của nó là của
  bạn.
- Không render link tải file từ nội dung khi không có allowlist các host.

## 4. Theo dõi gì

| Tín hiệu | Ở đâu |
| --- | --- |
| Thay đổi quản trị bất ngờ (extension, webhook, flow, setting, key, user) | Bộ lọc audit `admin_change` |
| Link tải file, URL canonical ngoài site, đợt xuất bản dồn dập, lần xuất bản đầu của một tài khoản | Bộ lọc audit `content_integrity_alert` |
| Mọi thứ đã lên live, theo tài khoản | Settings → Content integrity, và thông báo hằng tuần "What went live this week" |
| Đăng nhập thất bại, khoá tài khoản, đăng nhập từ nơi mới | Sự kiện audit `login_failed`, `user_locked`, `anomaly_triggered` |
| Hành động của agent đang chờ duyệt mà không ai yêu cầu | Mission Control → phê duyệt |
| Truy vấn tìm kiếm bạn không nhận ra | Search Console (§3) |

## 5. Runbook ứng phó

Khi bạn nghi có nội dung bị chèn:

1. **Dừng thay đổi.** Bật kill switch của agent cho site
   (`POST /api/v1/agent/kill-switch` với `{ "scope": "site" }`). Nếu site công
   khai đang phục vụ nội dung mồi, hãy đưa nó offline hoặc vào chế độ bảo trì ở
   frontend/CDN, và giữ lại một bản sao những gì nó đã phục vụ.
2. **Giữ bằng chứng.** Xuất audit log của khoảng thời gian đó, và lưu các
   revision item, dòng activity liên quan cùng log CDN / frontend ra ngoài CMS
   trước khi thay đổi gì khác.
3. **Cắt quyền truy cập.**
   - Tạm ngưng các tài khoản đã thực hiện thay đổi bất ngờ
     (`PATCH /api/v1/users/:id` với `{ "status": "suspended" }` — request của
     họ bị từ chối ngay lập tức).
   - Thu hồi các API key bạn không thể bảo đảm (`POST /api/v1/api-keys/:id/revoke`).
   - Xoay `JWT_SECRET` để chấm dứt mọi session nếu chưa rõ phạm vi.
4. **Tìm điểm xâm nhập.** Dùng các dòng `admin_change` (người thực hiện, IP,
   user agent, request id) và các sự kiện đăng nhập. Tìm extension, webhook,
   flow, domain hoặc API key mới, và các thay đổi policy đã mở rộng quyền.
5. **Khôi phục nội dung.** Hoàn tác các item bị chèn về một revision sạch
   (`POST /api/v1/items/:collection/:id/revert/:revisionId`), sửa hoặc xoá các
   trang bị chèn, và gỡ những extension, webhook và flow không do bạn tạo.
6. **Xoay mọi thứ khác có thể đổi những gì người truy cập thấy.** Deploy hook,
   token tích hợp git, credential CDN và DNS, secret của webhook và key của nhà
   cung cấp — từ một máy sạch.
7. **Bật lại với mặc định mạnh hơn.** Bật `enforceTfa` cho mọi policy có quyền
   ghi, và hành động `unpublish` của bộ giám sát toàn vẹn nội dung.
8. **Báo cáo.** Nếu chính LumiBase là điểm xâm nhập, hãy báo cáo riêng tư như mô
   tả trong [SECURITY.md](../../../SECURITY.md); bạn cũng có thể báo sự cố cho
   văn phòng FBI địa phương hoặc IC3, như FLASH đề nghị.
