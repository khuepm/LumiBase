---
version: 1
lastUpdated: 2026-11-19T20:13:27.584Z
sourceLang: en
translatedFrom: en
sourceHash: ec71b5b95a014934
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T20:13:27.584Z
codeVerifiedHash: ec71b5b95a014934
codeVerifiedClaims: 4
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

Host "của site" là các domain của site (`/api/v1/domains`) cộng với
`allowedHosts`, so theo tên miền đăng ký, nên `cms.acme.com` và `www.acme.com`
được tính là một site. Chỉ host, phần mở rộng file và đường dẫn field được ghi
lại — không bao giờ ghi nội dung.

## Điều gì xảy ra

Mỗi lần ghi phát ra tín hiệu sẽ ghi một dòng audit `content_integrity_alert`
(collection, id item, các tín hiệu, hành động, loại người thực hiện, user id,
run id của agent). Lọc tab audit bảo mật của Studio theo
`content_integrity_alert`, hoặc API audit log với
`?event=content_integrity_alert`.

Với chính sách `unpublish`, item mang tín hiệu `download_link` hoặc
`offsite_seo_url` được đặt lại về `draft` trước khi lần ghi trả về; revision của
nó được giữ lại và một dòng activity `integrity_unpublish` ghi nhận việc này.
`publish_burst` chỉ cảnh báo: riêng số lượng thì chưa phải bằng chứng. Trang
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
  "burstWindowMinutes": 10
}
```

| Khoá | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `enabled` | `true` | `false` tắt bộ giám sát cho site. |
| `action` | `notify` | `notify` hoặc `unpublish`. |
| `allowedHosts` | `[]` | Các host khác được tính là của site (CDN, máy chủ tải file). |
| `burstThreshold` | `25` | Số lần xuất bản lần đầu trong cửa sổ trước khi cảnh báo burst. |
| `burstWindowMinutes` | `10` | Cửa sổ thời gian của burst. |

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
- Search index và sự kiện realtime đã phát cho lần ghi trước khi `unpublish`
  không bị bộ giám sát thu hồi; lần quét index tiếp theo và việc vô hiệu cache
  sau lần ghi sẽ sửa lại chúng.
