---
version: 2
lastUpdated: 2026-11-16T06:46:05.816Z
sourceLang: en
translatedFrom: en
sourceHash: b29eea0dc869cc91
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-16T06:46:05.816Z
codeVerifiedHash: b29eea0dc869cc91
codeVerifiedClaims: 28
---

# Memberships & newsletters

LumiBase có thể vận hành một audience: **member** với quyền truy cập miễn phí, trả phí hoặc tặng (comped) trên một **tier**, **newsletter** mà member tự bật tắt, **segment đã lưu** luôn tự cập nhật, **email sequence** tự động, **sending domain** tuỳ chỉnh có DKIM, và một **Portal** nhúng được để đăng ký, đăng nhập và quản lý tài khoản (epic #672). Studio: **Settings → Audience → Members & newsletters** (`/settings/audience`).

Thanh toán không được xử lý ở đây: tier trả phí mang giá và id của nhà cung cấp thanh toán, còn một checkout hook được để sẵn cho phần tích hợp thanh toán.

## Member và tier

Một member là bản ghi audience của một người trên một site: email, tên, `status` (`free` | `paid` | `comped`), tier, nhãn, lựa chọn newsletter và hoạt động email (đã gửi, đã mở, lần mở gần nhất). Member do staff tạo hoặc import thì chưa có tài khoản; member đăng nhập qua Portal được liên kết với một tài khoản thuộc **subscriber realm** (session `frontend`, không vào được Studio — xem [user management](../security/user-management.md)).

| Status | Tier | Ai đặt |
|---|---|---|
| `free` | free tier của site (tạo ở lần dùng đầu) | đăng ký, staff, chuyển sang free tier |
| `paid` | một tier trả phí | payment hook (staff cũng đặt được) |
| `comped` | một tier trả phí, không thanh toán | staff |

**Nội dung gắn với tier dùng permission engine.** Mỗi tier sở hữu một policy bình thường (`policies.key = member-tier:<key>`, không có quyền admin hay Studio). Khi một member có tài khoản đang giữ một tier còn hiệu lực, policy đó được gắn vào tài khoản cho site này (`user_policies`); đổi tier, `tierExpiresAt` hết hạn, hoặc xoá member sẽ gỡ nó ra, và permission version được tăng để thay đổi có hiệu lực ngay request tiếp theo. Cấp quyền read trên một collection bằng `PUT /api/v1/members/tiers/:id/access`, hoặc chỉnh policy trong **Access → Policies** như mọi policy khác (ví dụ lọc theo field `visibility`). Nội dung mà mọi member đã đăng nhập đều đọc được thì thuộc về grant của realm `subscriber` (`POST /api/v1/users/subscriber-access`).

Khi một member hạ xuống `free`, các newsletter chỉ dành cho người trả phí của họ bị bỏ.

## Member Portal

Portal tắt cho tới khi bật **Portal → Enable the member Portal**. API công khai của nó là `/api/v1/portal/*`:

1. `POST /api/v1/portal/magic-link` `{ email, name?, newsletters?, redirectUri?, intent }` trả cùng một `202` dù địa chỉ có phải member hay không (đăng nhập cho một địa chỉ lạ thì không gửi gì). Link trỏ tới một landing URL mà site đã đăng ký (**khớp chính xác**, cùng quy tắc với social login), kèm `?lumi_member_token=…`. Chỉ lưu SHA-256 của token; token dùng được một lần và hết hạn sau 24 giờ. Request bị hãm theo IP và giới hạn 5 link mỗi địa chỉ trong 15 phút.
2. Trang landing gửi token tới `POST /api/v1/portal/magic-link/verify`. Một câu update có điều kiện tiêu thụ nó, nên một link tạo tối đa một session. Đăng ký tạo free member, đăng ký các newsletter đã chọn (hoặc mặc định), cấp một tài khoản subscriber không mật khẩu và trả về session `frontend` — cùng hình dạng với `/auth/login`.
3. Với session đó, `GET/PATCH/DELETE /api/v1/portal/me` đọc hồ sơ, bật tắt newsletter, huỷ đăng ký mọi thứ hoặc rời đi; `POST /api/v1/portal/me/tier` chuyển sang một free tier hoặc xin payment hook một checkout URL (`402 PAYMENT_PROVIDER_NOT_CONFIGURED` khi chưa có).

Magic link không bao giờ trở thành đường vòng qua mật khẩu và yếu tố thứ hai: khi địa chỉ thuộc về một tài khoản hơn mức subscriber (vai trò staff trên bất kỳ site nào, bootstrap admin, hoặc đã đăng ký yếu tố thứ hai), member được xác minh nhưng không có session nào được cấp (`409 PASSWORD_LOGIN_REQUIRED`).

### Portal widget

`@lumibase/portal` render signup card và màn hình tài khoản (bật tắt newsletter, đổi tier, đăng xuất). Có ba cách dùng:

```html
<!-- Plain HTML: the script defines <lumi-portal> and mounts every [data-lumi-portal] -->
<script src="https://unpkg.com/@lumibase/portal/dist/portal.min.js" defer></script>
<lumi-portal api="https://cms.example.com" site="site_1" locale="vi"
             redirect-uri="https://blog.example.com/welcome" newsletters="weekly"></lumi-portal>
```

```tsx
// React / Next.js (client component)
import { LumiPortal } from '@lumibase/portal/react';

<LumiPortal url="https://cms.example.com" siteId="site_1" locale="vi" redirectUri="https://blog.example.com/welcome" />;
```

```ts
import { mountPortal } from '@lumibase/portal';

mountPortal(document.getElementById('portal'), { url: 'https://cms.example.com', siteId: 'site_1' });
```

Trên trang landing, widget đọc `lumi_member_token`, xoá nó khỏi thanh địa chỉ, đổi nó lấy session và lưu session (trong bộ nhớ khi storage bị chặn). Thiếu option, landing URL hỏng hoặc thuộc tính `copy` hỏng thì không render gì hoặc quay về mặc định — widget không bao giờ ném lỗi vào trang chủ, và chuỗi từ server được đặt dưới dạng text, không bao giờ là HTML. Đổi giao diện bằng CSS custom property: `--lumi-portal-accent`, `--lumi-portal-accent-text`, `--lumi-portal-text`, `--lumi-portal-muted`, `--lumi-portal-border`, `--lumi-portal-bg`, `--lumi-portal-radius`, `--lumi-portal-font`. SDK có các lời gọi tương tự dưới dạng command (`requestMemberLink`, `verifyMemberLink`, `getMember`, `updateMember`, `switchMemberTier`, `leaveMembership`).

### Signup card block

**Portal → Install signup card block** (`POST /api/v1/members/signup-card/install`) thêm block template `signup_card`: `heading`, `description`, `placeholder`, `button_label` và `success_message` là field `translatable-text`, cùng `newsletters`, `collect_name` và `layout`. Copy được giải theo từng field: override của chính card cho locale → copy của site cho locale (`pt-BR`, rồi `pt`) → mặc định có sẵn cho locale (có sẵn tiếng Anh và tiếng Việt). Widget và `GET /api/v1/portal/signup-card?locale=` dùng chung một hàm (`resolveSignupCopy` trong `@lumibase/contracts/members`), nên một trang đã bản địa hoá không bao giờ hiện placeholder tiếng Anh viết cứng. Truyền data của card cho widget bằng `signupCardOverrides(data)`.

## Segment đã lưu

Một segment là một bộ lọc có tên; số lượng được tính ở mỗi lần đọc, nên nó thay đổi khi member đăng ký, đổi tier hoặc mở email — không có gì được materialize để có thể cũ đi. Studio làm mới số lượng mỗi 15 giây.

```json
{
  "match": "all",
  "conditions": [
    { "field": "status", "op": "in", "value": ["paid", "comped"] },
    { "field": "last_email_opened_at", "op": "older_than_days", "value": 60 },
    { "field": "newsletter", "op": "subscribed", "value": "weekly" }
  ]
}
```

| Field | Toán tử | Giá trị |
|---|---|---|
| `status` | `in`, `not_in` | danh sách `free` / `paid` / `comped` |
| `tier` | `in`, `not_in` | key của tier |
| `label` | `has`, `not_has` | một nhãn |
| `newsletter` | `subscribed`, `not_subscribed` | key của một newsletter |
| `source` | `in`, `not_in` | `portal` / `admin` / `import` / `api` |
| `email_verified` | `is` | boolean |
| `created_at`, `last_seen_at`, `last_email_opened_at` | `before`, `after` (ngày ISO); `within_days`, `older_than_days` (số ngày); `never` | |
| `email_count`, `email_opened_count` | `gte`, `lte`, `eq` | số nguyên |
| `email_open_rate` | `gte`, `lte` | phần trăm 0–100 (member chưa từng nhận email không khớp bên nào) |

`match: "any"` nối các điều kiện bằng OR. Điều kiện tier và newsletter chỉ được giải trên cùng site. Một segment là audience của newsletter (`segmentId` trên một lần gửi), là trigger của sequence (`trigger: "segment"`) và là bộ lọc danh sách member (`GET /api/v1/members?segmentId=`).

## Newsletter

Một newsletter là một danh sách (`audience: members`, hoặc `paid` chỉ cho paid và comped) với người gửi, layout tuỳ chọn và theo dõi mở / click phải bật mới có. Một **issue** là một item được gửi một lần:

```http
POST /api/v1/members/newsletters/:id/sends
{ "collection": "posts", "itemId": "p1", "segmentId": null, "publish": true,
  "compose": { "subjectField": "title", "bodyField": "content", "locale": "en" } }
```

- `publish: true` là **Publish & send**: item được publish trước, qua chính quyền của bạn, rồi mới được đọc và soạn. Body có thể là HTML (nội dung chủ động bị loại bỏ), text thường, một map translatable, hoặc một tài liệu rich text (render bằng serializer dùng chung).
- Cùng một item không gửi được hai lần với cùng newsletter (`409 ALREADY_SENT`).
- Audience là người đăng ký newsletter, thu hẹp theo segment được đóng băng lúc tạo. Member huỷ đăng ký giữa chừng sẽ bị bỏ qua.
- Gửi theo lô: request trả `202` và chạy những lô đầu; members tick tiếp tục phần còn lại dưới một lease, 100 member mỗi lô. Mỗi người nhận có một dòng `newsletter_deliveries` trước khi email được gửi đi, nên một lần thử lại không bao giờ gửi hai lần cho member đã nhận.
- Mỗi thư mang link huỷ đăng ký riêng của member trong body và các header `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Mở link (`GET`) chỉ hiện một nút xác nhận, nên trình quét email và tính năng tải trước link không thể huỷ đăng ký ai; thay đổi chỉ xảy ra ở `POST` (nút bấm, hoặc one-click của nhà cung cấp hộp thư). Danh sách suppression của site được tôn trọng.
- Khi bật theo dõi, một pixel mở và redirect click có chữ ký ghi lại lần mở và lần click đầu tiên của mỗi member (`GET /api/v1/portal/email/o`, `/c`). Redirect click chỉ đi tới URL mà CMS đã ký — nó không phải open redirect.
- Địa chỉ người gửi phải nằm trên một sending domain đã xác minh (`409 SENDER_DOMAIN_UNVERIFIED`).

Biến template: `{{member.name}}`, `{{member.first_name}}`, `{{member.email}}`, `{{unsubscribe_url}}`, `{{post.title}}`, `{{newsletter.name}}`. Khi cả body lẫn layout đều không dùng `{{unsubscribe_url}}`, một link ở chân thư được thêm vào.

## Email sequence

Một sequence là danh sách bước có thứ tự (`delayMinutes` sau bước trước, tiêu đề, HTML) chạy cho từng member đã ghi danh. Có sẵn ba template ở dạng draft để xem lại trước khi kích hoạt:

| Template | Trigger | Các bước |
|---|---|---|
| `welcome` | `member.created` | ngay, +2 ngày, +5 ngày |
| `onboarding` | `member.tier_changed` sang paid / comped | ngay, +3 ngày |
| `win-back` | `segment` (ví dụ không mở email trong 60 ngày) | ngay, +7 ngày |

Trigger: `member.created` (tuỳ chọn chỉ một số status), `member.tier_changed` (tuỳ chọn một key tier), `segment` (member được ghi danh khi họ vào segment) và `manual`. Một member chỉ được ghi danh một lần mỗi sequence. Ghi danh dừng lại — không bước nào được gửi thêm — khi member huỷ đăng ký mọi thứ (Portal hoặc link một-click), bị suppress, hoặc bị xoá.

Sequence cũng làm việc với [Flows](./flows-automation.md): sự kiện member tới các flow kích hoạt theo sự kiện trên collection `lumibase_members` (action `create` / `update` / `delete`, payload `event` là `member.created` / `member.tier_changed` / `member.unsubscribed` / `member.deleted`), và operation `members:enroll` (`sequenceKey`, `memberId` mặc định là member của sự kiện) ghi danh sau khi flow đã rẽ nhánh.

## Sending domain tuỳ chỉnh

**Sending domains** (`/api/v1/email/sending-domains`) thiết lập một domain để gửi thư:

| Record | Host | Giá trị |
|---|---|---|
| SPF | `<domain>` | `v=spf1 a mx include:relay.mailchannels.net ~all` (MailChannels) hoặc include của nhà cung cấp SMTP của bạn |
| DKIM | `<selector>._domainkey.<domain>` | `v=DKIM1; k=rsa; p=<2048-bit key>` |
| DMARC | `_dmarc.<domain>` | `v=DMARC1; p=none; adkim=r; aspf=r` để bắt đầu |

Giá trị DKIM 2048-bit dài hơn một chuỗi TXT 255 byte, nên wizard cũng đưa sẵn bản đã tách thành các đoạn có dấu ngoặc kép. **Check DNS** tra cứu các record (DNS over HTTPS, nên chạy được trên cả hai runtime); domain là `verified` khi khoá DKIM và một record SPF đã được publish. Kiểm tra DMARC báo policy và **alignment**: mọi người gửi newsletter trên domain phải align với `d=<domain>` theo chế độ `adkim` của record (strict = đúng domain đó). Thư từ một domain đã xác minh được ký DKIM bằng khoá đang hoạt động của nó trên SMTP và trên MailChannels. Private key được niêm phong bằng key provider của deployment.

**Xoay khoá không gián đoạn.** Việc xoay đến hạn 180 ngày sau khi xác minh (hoặc khi bấm **Rotate DKIM**): một khoá mới được tạo dưới một selector mới và liệt kê cạnh khoá hiện tại; khi một lần kiểm tra đã thấy nó được publish hơn một giờ, việc ký chuyển sang nó, và selector cũ vẫn được liệt kê thêm 7 ngày để thư ký bằng nó vẫn xác minh được. Sau đó wizard đánh dấu record cũ là có thể xoá.

## Multi-tenancy

Mọi bảng mới có `site_id`, nằm trong danh sách RLS `site_isolation` và mọi query đều gắn với site; các sub-select của segment (tier, newsletter) lặp lại điều kiện site. Cô lập theo site: member, tier và policy của chúng, segment, newsletter, lần gửi, delivery, sequence, ghi danh, sending domain và khoá của chúng, token magic link và setting Portal. Dùng chung trong deployment: email transport, `JWT_SECRET` (ký link huỷ đăng ký và link theo dõi; mỗi token nêu site của nó và handler scope database handle về site đó) và key provider (private key DKIM được niêm phong với AAD nêu site, domain và selector). Members tick chạy trên system connection xuyên site và lấy `site_id` của mỗi đơn vị công việc từ dòng mà nó đã claim. Được kiểm bằng `members.db.integration.test.ts` và `members-routes.db.integration.test.ts` (hai site: cùng email và key tier trên cả hai, token magic link của site A bị từ chối ở site B, member site B không bao giờ nhận thư từ lần gửi của site A, link huỷ đăng ký được thực hiện trên đúng site của nó dù tới từ host nào).

## Cấu hình

| Biến | Dùng cho |
|---|---|
| `LUMIBASE_PUBLIC_URL` | Origin công khai của CMS cho link huỷ đăng ký và theo dõi. Lần gửi khởi từ Studio dùng origin của request nếu thiếu; sequence thì cần biến này. |
| `JWT_SECRET` | Ký token link của member (vốn đã bắt buộc). |
| `LUMIBASE_SMTP_URL` / MailChannels | Transport, như mọi email khác. |

Members tick chạy mỗi phút trên Docker (có leader lock) và trên minute trigger của Workers.
