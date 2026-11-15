---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:55:15.280Z
translatedFrom: en
sourceHash: 926006bb5a72acbe
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T16:55:15.280Z
codeVerifiedHash: 926006bb5a72acbe
codeVerifiedClaims: 4
---

# Studio Intent Links

**Intent link** là một URL ổn định yêu cầu Studio mở, tạo hoặc sửa một nội dung
— ở một locale nhất định, cuộn tới một field nhất định — mà nơi tạo link không
cần biết route nội bộ của Studio. Overlay preview, thông báo, chat agent hay
email đều có thể tạo cùng một link, và link vẫn hoạt động khi bố cục Studio
thay đổi.

```
https://cms.example.com/lumi-7f3a9c/intent/edit?collection=posts&id=p_123&locale=vi&field=title
```

## Contract (version 1)

Dạng URL là `{studioOrigin}{adminPath?}/intent/{action}?{params}`.

| Param | Bắt buộc | Ý nghĩa |
|---|---|---|
| `collection` | luôn luôn | Tên collection (identifier: chữ, số, `_`). |
| `id` | `edit`; tùy chọn với `open`; cấm với `create` | Id của item. `open` không có id sẽ mở danh sách collection. Id `new` và `reviews` được dành riêng và bị từ chối. |
| `locale` | tùy chọn | Tag locale (`en`, `vi`, `pt-BR`). Locale đầu tiên của site mở tab Fields; mọi locale khác đang bật mở Translation mode với target là locale đó. |
| `field` | tùy chọn | Field cần cuộn tới và focus. Cần một item (`open`/`edit` có `id`) hoặc `create`. |
| `site` | tùy chọn | Id của site. Khi khác site đang hoạt động, Studio hỏi trước khi chuyển và từ chối nếu người dùng không có quyền truy cập. |
| `v` | tùy chọn | Phiên bản contract; vắng mặt nghĩa là `1`. |

Action: `open`, `create`, `edit`.

Các quy tắc giữ contract ổn định:

- Param không xác định, param bị lặp, `v` không xác định và giá trị sai định
  dạng đều bị từ chối bằng một trang lỗi thân thiện liệt kê mọi vấn đề — Studio
  không bao giờ đoán. Các param tracking `utm_*` là ngoại lệ duy nhất được bỏ qua.
- Có thể thêm param tùy chọn mới trong v1; thay đổi ý nghĩa thì tăng `v`.
- Không có `site`, link tác động lên site đang hoạt động của người dùng. Nơi tạo
  link biết site (mọi producer phía CMS đều biết) nên luôn đặt param này.

### Tạo link

`@lumibase/contracts/intents` export builder và parser dùng chung cho CMS,
Studio và extension. Builder kiểm tra bằng đúng các quy tắc Studio áp dụng, nên
producer không thể tạo ra một link mà Studio sẽ từ chối.

```ts
import { buildStudioIntentPath, buildStudioIntentUrl } from '@lumibase/contracts/intents';

// Admin-relative — for in-app links and notification `deepLink`s.
buildStudioIntentPath({ action: 'edit', collection: 'posts', id: 'p_123', field: 'title' });
// → '/intent/edit?collection=posts&id=p_123&field=title'

// Absolute — for email, chat and push.
buildStudioIntentUrl(
  { action: 'edit', collection: 'posts', id: 'p_123', locale: 'vi', field: 'title', site: 'site_1' },
  { studioUrl: 'https://cms.example.com', adminPath: '/lumi-7f3a9c' },
);
```

`parseStudioIntent(action, params)` trả về `{ ok: true, intent }` hoặc
`{ ok: false, errors }`; `studioIntentRoute(intent)` cho ra route có sẵn của
Studio. Màn diff của veto window trong Mission Control dùng
`buildStudioIntentPath` (qua component `IntentLink` của Studio) để "Open item"
mở đúng field đầu tiên mà agent muốn thay đổi.

## Studio xử lý link như thế nào

1. **Đăng nhập.** Người chưa đăng nhập truy cập `/{adminPath}/intent/...` được
   chuyển tới `/{adminPath}/login?next=/intent/...`. Sau khi đăng nhập (kể cả
   bước MFA) Studio quay lại intent, giữ nguyên admin prefix. Session hết hạn
   khi mở intent link cũng giữ link theo cách tương tự.
2. **Kiểm tra.** Query string thô được parse theo contract v1.
3. **Site.** Nếu `site` khác site đang hoạt động, Studio hỏi CMS
   (`GET /api/v1/auth/me` với `X-Lumi-Site` của site đó) xem session có được
   dùng site này không. Được phép → một hộp xác nhận "Switch site?" rõ ràng; bị
   từ chối → trang lỗi. Không bao giờ mở nội dung ở site hiện tại thay thế.
4. **Extension claim**, sau đó là **route có sẵn**
   (`/content/{collection}/{id}?locale=&field=`, `/content/{collection}/new`, hoặc
   `/content/{collection}`).
5. **Editor.** Item editor áp dụng `locale` (tôn trọng các locale site đang bật
   và field nào có thể dịch), mở group đang thu gọn chứa `field`, cuộn tới và
   focus vào editor của field. Locale site không bật, field không dịch được hoặc
   field người dùng không thấy sẽ hiện một thông báo thay vì bị bỏ qua âm thầm.

### Không có open redirect

Mọi đích đến đều là nội bộ. `next` của trang đăng nhập phải là một intent path
admin-relative; URL tuyệt đối, `//host`, mẹo dấu gạch ngược, ký tự điều khiển,
fragment và việc viết lại bằng dot-segment đều bị từ chối. Path do extension
handler trả về cũng đi qua cùng phép kiểm tra, và handler không thể đưa người
dùng quay lại `/intent/...`.

## Extension claim intent

Một Studio extension có thể tiếp quản một intent (ví dụ mở một review panel
riêng thay vì editor mặc định). Export các handler dưới tên `intents` từ bundle
và xin capability cho mỗi claim:

```ts
import { defineIntentHandler } from '@lumibase/extension-sdk';

export const intents = [
  defineIntentHandler({
    id: 'seo-panel',
    canHandle: (intent) => (intent.action === 'edit' && intent.field === 'seo' ? 10 : 0),
    // Send "edit the seo group" links to the concrete field editors care about.
    handle: (intent) => ({ navigate: `/content/${intent.collection}/${intent.id}?field=seo_title` }),
  }),
];
```

- **Giới hạn theo capability.** Handler chỉ được đưa những intent mà capability
  đã cấp của extension bao phủ:
  `intents:claim:<action>:<collection>`, cho phép `*` ở cả hai phần
  (`intents:claim:edit:posts`, `intents:claim:*:posts`).
- **Phân giải tất định.** Trong các handler được bao phủ có `canHandle` trả về
  một số hữu hạn lớn hơn 0, handler cao nhất thắng; hòa thì so tên extension,
  rồi `id` của handler. Trả về `0`, `false` hoặc `null` là từ chối.
- **Fallback.** Nếu `handle` của handler thắng throw, trả về
  `{ fallback: true }`, hoặc trả về path không an toàn, route có sẵn sẽ chạy.
  Handler xếp thứ hai không được thử.
- Bundle của extension có capability `intents:claim:*` chỉ được import khi đang
  phân giải một intent, không phải ở lần tải Studio bình thường.

## Form layouts

Cơ chế hiện field là chung: editor công bố field cần focus và chuỗi container
chứa nó qua `FieldRevealContext`
(`apps/studio/src/modules/content/field-focus.tsx`). Group container gọi
`useRevealContainer(name)` để tự mở. Một form layout dạng tab sau này có thể làm
tương tự, hoặc đọc `useFieldReveal()` và chuyển sang tab chứa field đích.

## Desktop and mobile shell

Tauri shell chuyển các deep link `lumibase://` tới Studio dưới dạng event
`shell://deep-link`. Studio ánh xạ dạng intent sang đúng route mà trình duyệt
dùng:

```
lumibase://intent/edit?collection=posts&id=p_123&field=title
```

Trên mobile, universal link trên `studio.lumibase.dev` hiện chỉ đăng ký cho
`/oauth` và `/auth`; khi `/intent` được thêm vào `pathPrefix` của shell (và file
association của host), các link đó tới cùng handler mà không cần sửa Studio.
Link khởi động desktop app từ trạng thái tắt hẳn có thể tới trước khi Studio
đăng ký nghe event; khi đó hãy mở lại link.

## Giới hạn đã biết

- Admin path được chọn đúng bằng `/intent` sẽ xung đột với intent route (giới
  hạn tương tự đã có với `/content`, `/settings`, …).
- `locale` trên intent `create` được chấp nhận nhưng form tạo item mới luôn bắt
  đầu ở locale mặc định của site.
