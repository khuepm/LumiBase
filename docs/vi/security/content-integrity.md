---
version: 3
lastUpdated: 2026-11-21T03:52:31.907Z
sourceLang: en
translatedFrom: en
sourceHash: 241fbe6d9887f2d1
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-21T03:52:31.907Z
codeVerifiedHash: 241fbe6d9887f2d1
codeVerifiedClaims: 8
---

# Giám sát toàn vẹn nội dung

LumiBase kiểm tra nội dung khi nó được đưa lên live và phát cảnh báo khi nội
dung trông giống bị chèn (#989). Mô hình tham chiếu là chiến dịch trong FBI
FLASH CC-111626-MW: các site bị chiếm quyền vẫn chạy bình thường với chủ site,
trong khi phục vụ trang mồi đưa cho người truy cập một file ZIP chứa JavaScript,
cùng các tín hiệu tìm kiếm trỏ sang nơi khác. Cách kiểm tra quen thuộc của chủ
site — mở site, đọc bài mới nhất — không thấy gì.

## Những gì được kiểm tra

Sau mỗi lần ghi khiến một item ở trạng thái `published`, và sau khi một trang
delivery được tạo hoặc đổi layout (`modules/content-integrity/monitor.ts`):

| Tín hiệu | Phát ra khi |
| --- | --- |
| `download_link` | Bất kỳ chuỗi nào trong nội dung — field thường, JSON lồng nhau, rich text, HTML — liên kết tới file nén hoặc file thực thi (`.zip`, `.js`, `.exe`, `.msi`, `.iso`, `.ps1`, `.vbs`, `.jar`, `.apk`, `.dmg`, …) trên một host không thuộc site. |
| `offsite_seo_url` | Giá trị `canonical`, `og_url` / `og:url` hoặc `twitter_url` trỏ tới host khác. Chỉ kiểm khi site đã có ít nhất một host được biết. |
| `publish_burst` | Số item được xuất bản lần đầu trên toàn site trong `burstWindowMinutes` gần nhất vượt `burstThreshold` (cảnh báo ở lần vượt ngưỡng và ở mỗi bội số tiếp theo, không phải mỗi lần xuất bản). |
| `first_publish_by_principal` | Một tài khoản user đưa một item lên live lần đầu và không có item đã xuất bản nào khác trên site được tài khoản đó ghi lần cuối. Lần xuất bản đầu tiên của một tài khoản bị đánh cắp hoặc lâu không dùng đáng được xem lại. API key, agent và thao tác hệ thống không được kiểm. |

Host "của site" là các domain của site (`/api/v1/domains`) cộng với
`allowedHosts`, so theo tên miền đăng ký, nên `cms.acme.com` và `www.acme.com`
được tính là một site. Trên một hậu tố hosting dùng chung (`pages.dev`,
`workers.dev`, `github.io`, `vercel.app`, `netlify.app` và tương tự), mỗi
subdomain là một site riêng: `acme.pages.dev` không coi `attacker.pages.dev` là
của mình. Chỉ host, phần mở rộng file và đường dẫn field được ghi lại — không
bao giờ ghi nội dung.

## Điều gì xảy ra

Mỗi lần ghi phát ra tín hiệu sẽ ghi một dòng audit `content_integrity_alert`
(collection, id item, các tín hiệu, hành động, loại người thực hiện, user id,
run id của agent). Lọc tab audit bảo mật của Studio theo
`content_integrity_alert`, hoặc API audit log với
`?event=content_integrity_alert`.

Với chính sách `unpublish`, item mang tín hiệu `download_link` hoặc
`offsite_seo_url` được đặt lại về `draft` trước khi lần ghi trả về; revision của
nó được giữ lại và một dòng activity `integrity_unpublish` ghi nhận việc này.
`publish_burst` hay `first_publish_by_principal` chỉ cảnh báo: riêng số lượng hay sự mới lạ thì chưa phải bằng chứng. Trang
không có trạng thái nháp, nên chỉ cảnh báo.

Khi nội dung đến từ một run của agent, bộ giám sát còn ghi một incident
`content_integrity` (mức high) cho role của agent trên `items:update` và
`items:create`, làm hạ cấp các grant đó — xem [AI skills](../ai-skills.md).

## Chính sách

Setting của site `contentIntegrity`, do site admin ghi bằng `POST /api/v1/settings` với `{ "key": "contentIntegrity", "value": { … } }`:

```json
{
  "enabled": true,
  "action": "notify",
  "allowedHosts": ["cdn.acme-assets.net"],
  "burstThreshold": 25,
  "burstWindowMinutes": 10,
  "firstPublishSignal": true,
  "weeklyDigest": true
}
```

| Khoá | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `enabled` | `true` | `false` tắt bộ giám sát cho site. |
| `action` | `notify` | `notify` hoặc `unpublish`. |
| `allowedHosts` | `[]` | Các host khác được tính là của site (CDN, máy chủ tải file). |
| `burstThreshold` | `25` | Số lần xuất bản lần đầu trong cửa sổ trước khi cảnh báo burst. |
| `burstWindowMinutes` | `10` | Cửa sổ thời gian của burst. |
| `firstPublishSignal` | `true` | `false` tắt `first_publish_by_principal`. |
| `weeklyDigest` | `true` | `false` dừng thông báo hằng tuần "những gì đã lên live". |

Studio chỉnh tất cả những mục này trong **Settings → Content integrity**.

## Những gì đã lên live: bản tổng hợp

Phép quét chỉ thấy những gì nó có rule. Bản tổng hợp là phép kiểm không phụ
thuộc vào nó: mọi thứ đã lên live, để một người có thể hỏi "mình có nhận ra cái
này không?".

- `GET /api/v1/admin/security/content-integrity/digest?days=7` (site admin;
  `days` từ 1 tới 31) trả về các item được xuất bản lần đầu trong cửa sổ, số
  lượng theo từng tài khoản đã ghi chúng lần cuối (`published.byPrincipal`, kèm
  email), 100 item mới nhất trong số đó (`published.items`), và các cảnh báo
  của cửa sổ theo tín hiệu (`alerts.bySignal`). **Settings → Content
  integrity** hiển thị 7 ngày gần nhất.
- Cứ 7 ngày một lần, từ job định kỳ hằng giờ (Node và Workers), mỗi
  administrator của site nhận một thông báo Studio, "What went live this week",
  với cùng bản tóm tắt (`modules/content-integrity/digest.ts`). Nó được bỏ qua
  cho site không có gì lên live và không có cảnh báo nào, hoặc khi `enabled`
  hay `weeklyDigest` là `false`.

## Multi-tenancy

Mọi thứ theo từng site: chính sách là một setting của site, dòng cảnh báo và
activity mang `site_id`, số đếm burst và tra cứu domain đều giới hạn theo
`site_id`. Không có gì dùng chung giữa các tenant.

## Giới hạn

- Bộ giám sát chỉ thấy nội dung lưu trong LumiBase. Cloaking — phục vụ cho bot
  tìm kiếm một thứ và cho người truy cập thứ khác — xảy ra ở frontend hoặc CDN
  render nội dung, nằm ngoài tầm của nó. Hãy xem các truy vấn trong search
  console có cụm từ không liên quan tới site không, và so sánh nội dung mà
  crawler và trình duyệt nhận được.
- Nó fail open: nếu bản thân phép kiểm không chạy được, lần ghi vẫn đi qua và
  lỗi được ghi log. Nó không chặn lần ghi nào ngoài hành động `unpublish`.
- Một lần import hàng loạt xuất bản nhiều item sẽ phát cảnh báo
  `publish_burst`; hãy nâng `burstThreshold` cho site xuất bản theo lô lớn.
- `first_publish_by_principal` đọc người ghi item lần cuối (`user_updated`),
  không phải lịch sử xuất bản: một tài khoản chỉ từng sửa các item do người
  khác xuất bản vẫn được tính là mới. Trên một site mới, lần xuất bản đầu tiên
  của mỗi tài khoản phát tín hiệu này một lần.
- Search index và sự kiện realtime đã phát cho lần ghi trước khi `unpublish`
  không bị bộ giám sát thu hồi; lần quét index tiếp theo và việc vô hiệu cache
  sau lần ghi sẽ sửa lại chúng.
