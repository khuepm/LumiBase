---
sourceLang: en
version: 3
lastUpdated: 2026-11-20T06:20:32.124Z
translatedFrom: en
sourceHash: 41a7d799fc101f91
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-20T06:20:32.124Z
codeVerifiedHash: 41a7d799fc101f91
codeVerifiedClaims: 16
---

# Thử nghiệm A/B

Một **experiment** chia lưu lượng của một trang hoặc một item giữa các
**arm** và đếm arm nào chuyển đổi tốt hơn (#763, epic #678). Báo cáo nằm trong
Insights, một agent có thể đề xuất arm thắng, và arm thắng chỉ được promote
sau khi một người duyệt.

Experiment xây trên [Cá nhân hoá](./personalisation.md): một arm ghi đè nội
dung giống như một biến thể, và delivery keyed cache theo arm được gán giống
như keyed theo audience.

## 1. Tạo experiment

```http
POST /api/v1/experiments
{
  "key": "hero",
  "name": "Hero headline",
  "hypothesis": "A shorter headline gets more sign-ups.",
  "subjectType": "page",
  "subjectId": "<page id>",
  "goal": "signup",
  "minSampleSize": 500,
  "arms": [
    { "key": "control", "weight": 50 },
    { "key": "b", "weight": 50, "overrides": { "title": "Ship content faster" } }
  ]
}
```

- `subjectType` là `page` (ghi đè `{ title?, layoutConfig? }`) hoặc `item`
  (ghi đè là một object `data` một phần).
- Có 2–4 arm. Một arm phải là `control`: nó phục vụ nội dung đã xuất bản và
  không có ghi đè. Mọi arm khác thay đổi ít nhất một trường.
- `weight` là phần lưu lượng của arm so với các arm khác (0–100). Arm có
  weight 0 không nhận lưu lượng.
- `goal` là tên chuyển đổi mà frontend báo về (ví dụ `signup`).
- `minSampleSize` là số exposure mỗi arm cần có trước khi một arm thắng được
  đề xuất (mặc định 100).

Experiment mới là `draft` và không thay đổi gì. Sau đó:

| Lệnh gọi | Từ → sang |
|---|---|
| `POST /api/v1/experiments/:id/start` | `draft` hoặc `stopped` → `running` |
| `POST /api/v1/experiments/:id/stop` | `running` → `stopped` |
| `PATCH /api/v1/experiments/:id` | tên, giả thuyết, goal, `minSampleSize`; `arms` chỉ khi còn `draft` |
| `DELETE /api/v1/experiments/:id` | mọi trạng thái trừ `running` |

Mỗi trang hoặc item chỉ chạy một experiment (`409 SUBJECT_BUSY`), và tối đa 5
experiment chạy trên mỗi site (`409 TOO_MANY_RUNNING`), vì mỗi experiment nhân
số bản cache của các trang nó chạm tới.

## 2. Chia lưu lượng khi delivery

`GET /api/v1/deliver/page/:site_id/:slug` lấy các experiment đang chạy của
site có thể chạm tới trang: experiment trang trên slug đó và mọi experiment
item. Nó gán cho khách một arm từ hai header của request:

- `X-Lumi-Visitor`: id khách mờ (opaque), first-party của chính site
  (8–128 ký tự `A-Z a-z 0-9 _ -`).
- `X-Lumi-Consent: analytics`. `DNT: 1` hoặc `Sec-GPC: 1` rút consent này.

Việc gán là tất định: cùng một khách luôn thấy cùng một arm, và không lưu gì
về khách. Mỗi experiment dùng salt riêng, nên hai experiment chia độc lập với
nhau.

Không có consent hoặc không có id khách, khách nhận nội dung `control` và
không nằm trong experiment.

Response khi đó mang:

- nội dung của arm (arm của experiment thắng biến thể audience trên cùng
  trang);
- `experiments: [{ key, arm }]` trong payload và
  `X-Lumi-Experiments: key=arm,…`, cho các experiment đã chạm tới trang này và
  khách đang nằm trong;
- `Vary` có `X-Lumi-Visitor` và các header consent.

Mọi tầng cache keyed theo các arm được gán, không bao giờ theo id khách: key
edge có thêm `__exp=hero:b`, key app-cache và `ETag` cũng chứa nó. Một trang
dưới thử nghiệm hai arm có tối đa ba bản: `b`, `control`, và "không nằm trong
experiment".

## 3. Báo exposure và chuyển đổi

Frontend báo những gì nó đã hiển thị và những gì đã chuyển đổi về beacon công
khai, kèm đúng id khách mà trang đã được phục vụ:

```http
POST /api/v1/experiment-events/:site_id
X-Lumi-Consent: analytics
X-Lumi-Visitor: <the site's visitor id>

{ "events": [
  { "experiment": "hero", "arm": "b", "kind": "exposure" },
  { "experiment": "hero", "arm": "b", "kind": "conversion", "goal": "signup" }
] }
```

Số liệu được tính **theo khách**, đúng như phần thống kê của báo cáo giả định:
mỗi khách là một lần thử, chuyển đổi hoặc không.

- **Một lần mỗi khách.** Mỗi khách được đếm một lần cho mỗi experiment, ở arm
  mà phép gán tất định dành cho họ. Sự kiện cho arm khác không được đếm, nên
  client không thể ghi công cho một arm nó không được hiển thị.
- **Exposure.** Exposure được đếm ở lần đầu. Gửi lại không thay đổi gì.
- **Chuyển đổi.** Chuyển đổi phải nêu `goal` của experiment. Nó chỉ được đếm
  sau một exposure của cùng khách vào cùng arm, và chỉ một lần. Vì vậy số
  chuyển đổi không bao giờ vượt quá số exposure.

Beacon trả `204` dù sự kiện có được đếm hay không. Nó chỉ trả `400` khi request
sai dạng:

- chuyển đổi không có `goal`;
- thiếu hoặc sai dạng `X-Lumi-Visitor`;
- body không hợp lệ.

Sự kiện bị bỏ với bot và khi không có consent analytics; `DNT` và `Sec-GPC`
rút consent. Mỗi lần gọi nhận tối đa 10 sự kiện, và route bị giới hạn tốc độ
như beacon pageview.

Id khách không bao giờ được lưu. Mỗi người tham gia được giữ dưới dạng SHA-256
của `<experiment id>:<visitor id>`: một chiều, và có salt theo experiment nên
không thể liên kết giữa các experiment. Người tham gia bị xoá cùng experiment
của họ.

`@lumibase/analytics-consent` có sẵn helper:

```ts
import { experimentsFromHeaders, exposuresFor, conversionsFor, sendExperimentEvents } from '@lumibase/analytics-consent';

const arms = experimentsFromHeaders(res.headers);
await sendExperimentEvents(consent, exposuresFor(arms), { cmsUrl, siteId, visitor });
// later, on sign-up:
await sendExperimentEvents(consent, conversionsFor(arms, 'signup'), { cmsUrl, siteId, visitor });
```

## 4. Báo cáo (Insights)

`GET /api/v1/experiments/:id/report` trả về, cho từng arm:

- exposure, chuyển đổi và tỉ lệ chuyển đổi;
- `uplift`: mức thay đổi tương đối so với control;
- `z` và `pValue` từ kiểm định z hai tỉ lệ so với control;
- `significant`: true khi `pValue` dưới 0.05 chia cho số arm thách thức
  (Bonferroni).

Exposure và chuyển đổi được tính theo khách. Nếu số liệu của một arm không còn
là mẫu hợp lệ theo khách (chẳng hạn chuyển đổi nhiều hơn exposure), arm đó
được liệt kê trong `invalidArms`, và không có significance hay đề xuất nào
được tính.

Nó cũng trả `sampleReached`, chuỗi số liệu theo ngày, và một `recommendation`:

| Đề xuất | Khi nào |
|---|---|
| `null` | có arm chưa đủ `minSampleSize` exposure, hoặc không arm nào khác biệt có ý nghĩa |
| một arm thách thức | nó thắng control có ý nghĩa (arm tốt nhất, nếu có nhiều arm như vậy) |
| `control` | mọi arm thách thức đều kém hơn có ý nghĩa |

Studio hiển thị nó ở **Insights → Experiments**: bảng các arm, đề xuất, start
/ stop, và *Request promotion*.

## 5. Promote arm thắng (phê duyệt)

Việc promote luôn đi qua phê duyệt (HITL):

- `POST /api/v1/experiments/:id/promote { arm, rationale? }` không promote. Nó
  tạo một approval `promoteExperimentWinner` đang chờ và trả `202` kèm
  `approvalId`.
- Agent cũng làm như vậy: `analyzeExperiment({ experimentId })` đọc báo cáo,
  và `promoteExperimentWinner({ experimentId, arm, rationale? })` là skill được
  quản trị (`dangerous`), nên nó chờ duyệt như các thao tác control-plane khác.

Khi người duyệt chấp thuận, arm thắng trở thành nội dung đã xuất bản. Tiêu đề
và layout của trang thay đổi qua page service; các trường của item thay đổi
qua item service, nên validation, revision và quyền áp dụng như mọi lần sửa.
Experiment kết thúc ở trạng thái `completed` với `winnerArm` được ghi, và
delivery ngừng chia lưu lượng. Promote `control` không thay đổi nội dung.

Khi duyệt, quyền hiện tại của người yêu cầu được kiểm tra lại. Một experiment
đã `completed` không thể được promote lần thứ hai.

## Dữ liệu và multi-tenancy

Migration `0045_experiments` thêm ba bảng, mỗi bảng có `site_id` và
row-level security:

- `lumibase_experiments`;
- `lumibase_experiment_arms`;
- `lumibase_experiment_participants`: mỗi khách một dòng, giữ khách đã băm,
  arm, `exposed_at` và `converted_at`.

Mọi query đều lọc theo site. Delivery và beacon lấy site từ URL. Danh sách
experiment đang chạy được cache theo site trong 60 giây và bị xoá mỗi khi có
thay đổi.

## Chưa làm

- Tạo và sửa experiment trong Studio. Studio hiển thị báo cáo; bạn tạo
  experiment qua API hoặc agent.
- Kiểm định tuần tự, bandit và giảm phương sai: kiểm định là kiểm định z hai
  tỉ lệ cố định.
- Goal định nghĩa từ pageview hoặc sự kiện CDC. Chuyển đổi do frontend báo về.
