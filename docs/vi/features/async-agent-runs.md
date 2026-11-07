---
version: 8
lastUpdated: 2026-11-07T17:57:18.483Z
sourceLang: en
translatedFrom: en
sourceHash: 6ef1425fd61bee3b
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-06T02:09:06.984Z
codeVerifiedHash: b657655b2141df34
codeVerifiedClaims: 8
---

# Lượt chạy agent bất đồng bộ

`POST /api/v1/agent/goals` nhận `execution: "async"`, một `task` chứa
`skillName` và `arguments`, cùng `budget`. API trả `202` với lượt chạy đang chờ.
Payload hàng đợi mang budget và tham chiếu principal; worker
phân giải quyền hiện tại khi nhận job. Thiếu binding hàng đợi
trả `400 ASYNC_UNAVAILABLE` trước khi tạo goal hoặc run.

## Thiết lập Cloudflare

`apps/cms/wrangler.toml` ghép producer `AGENT_RUNS_QUEUE` với consumer trong
cả năm profile. Runtime ánh xạ binding này sang hàng đợi logic
`agent-runs`; không dùng hàng đợi realtime làm phương án dự phòng.

| Profile | Hàng đợi |
| --- | --- |
| Local/default | `lumibase-agent-runs-local` |
| staging | `lumibase-agent-runs-staging` |
| production | `lumibase-agent-runs-production` |
| dev | `lumibase-agent-runs-dev` |
| demo | `lumibase-agent-runs-demo` |

Trước khi deploy một profile có tên, tạo hàng đợi nếu chưa tồn tại.
Với production, chạy từ `apps/cms`:

```bash
cd apps/cms
pnpm exec wrangler queues create lumibase-agent-runs-production
pnpm exec wrangler queues create lumibase-agent-runs-production-dlq
pnpm run deploy:production
```

Mỗi consumer dùng batch size 1, batch timeout 1 giây, ba lần retry,
và hàng đợi dead-letter có hậu tố `-dlq`. Cần theo dõi hàng đợi dead-letter;
lỗi giao nhận không chứng minh skill bị gián đoạn chưa tạo side effect.
Queue handler cần `HYPERDRIVE`; môi trường local có thể dùng `DATABASE_URL`
khi `LUMIBASE_ENV=development`. Cấu hình cùng bộ secret LLM và mã hoá
như đường thực thi đồng bộ. Worker nhận các provider cache, search, queue và key
từ runtime Cloudflare.
Cùng queue handler `queue()` đó của Worker (`processCloudflareQueue`) cũng định
tuyến các hàng đợi `flow-runs` và `flow-events`; xem
[Cloudflare Workers: queue của Flows](./flows-automation.md#cloudflare-workers-queue-của-flows).

## Thực thi và phục hồi

`apps/cms/src/cloudflare.ts` export queue handler. Handler chờ xử lý từng message
trước khi xác nhận và chỉ retry message có quá trình xử lý ném lỗi.
Message sai định dạng cũng đi qua retry giới hạn rồi dead-letter. Log định danh
hàng đợi và message, không sao chép tham số tool hoặc thông tin xác thực.

Worker dùng chung chỉ claim nguyên tử run ở trạng thái `queued`. Giao lại một
run đã được claim, đã huỷ hoặc đã hoàn tất không thực thi lại skill.
Sweep định kỳ năm phút cách ly các run `running` quá hạn; người vận hành phải
kiểm tra tool call trước khi quyết định retry. Kết quả dự kiến từ harness
như bị từ chối hoặc đang chờ duyệt được lưu lại và
message được xác nhận.

Job mới chuyển tiếp budget đã lưu. Job cũ thiếu budget trong payload
lấy budget từ run đã lưu. Vì vậy `maxToolCalls: 0` chặn tool call
đầu tiên. Việc đi qua queue không bỏ qua kiểm tra quyền hoặc yêu cầu con người duyệt.

Probe `health_check` dùng chung được xác nhận mà không chạy agent hoặc mở kết nối DB.

## Lỗi gửi vào queue

`POST /api/v1/agent/goals` trả `503 ENQUEUE_FAILED` kèm `goalId` và `runId`
khi gửi job thất bại. Xử lý bù chỉ chuyển run còn queued sang failed;
không ghi đè run mà worker đã nhận. Retry và reconciler
cũng dùng cùng phép chuyển trạng thái có điều kiện.

Goal bất đồng bộ mới lưu task dự định chạy trong metadata của goal, che secret
theo cùng quy tắc của audit tool-call. `POST /api/v1/agent/runs/:id/retry` có thể
khôi phục task dù lần gửi đầu chưa tới harness.
Tham số đã bị che không được replay; hãy gửi yêu cầu mới với
secret cần thiết. Goal cũ không có task được lưu vẫn cần yêu cầu mới.
Retry kiểm tra lại quyền và giữ budget đã lưu.

Sweep cũng chuyển run queued quá 15 phút sang failed ở mọi
origin của goal, với `queue_timeout`. Message tới muộn không thể nhận run đã failed.
Timeout này có thể hết hạn công việc khi queue tồn đọng lâu; cần retry tường minh,
không tự động replay. Run đang thực thi vẫn được cách ly riêng bằng
`stale_unverified` vì có thể đã phát sinh tác động.

## Dựng lại một run và quyết định phục hồi

Mọi kết quả đều được ghi trên các hàng tham chiếu lẫn nhau: goal, các run của nó
(`retryOfRunId` trỏ tới lần thử mà lần retry thay thế), các tool call của từng
run (`status`, `error`, `input`/`output` đã che, `latencyMs`), các hàng approval
(`runId`, `subjectId` = id của tool call), revision nội dung
(`createdByRunId`), và `agent_run.retried` trong activity, ghi ai đã yêu cầu
retry. Đọc trạng thái tool call trước trạng thái run:

| Run | Tool call | Chuyện gì đã xảy ra | Cần làm gì |
| --- | --- | --- | --- |
| `succeeded` | `executed` | Skill đã chạy và kết quả đã được lưu. | Không cần gì. Không retry được. |
| `failed` | `denied` | Bị từ chối trước khi thực thi (quyền, policy, autonomy). | Sửa nguyên nhân rồi retry. |
| `failed` | `failed` | Skill trả về lỗi. | Xem lỗi và retry nếu thao tác ghi không thể đã chạy một phần. |
| `failed` | `executed` | Skill đã chạy; việc lưu kết quả thất bại sau đó (`stopReason: worker_error`). | Tác động đã xảy ra. Retry bị từ chối với `409 RUN_EFFECT_RECORDED`. |
| `failed` | `running` | Tiến trình dừng giữa lúc thực thi (`stopReason: stale_unverified`). | Không rõ. Kiểm tra nội dung rồi retry hoặc để nguyên. |
| `cancelled` | không có, hoặc `denied` | Bị huỷ trước khi tool call kế tiếp bắt đầu. | Retry nếu vẫn cần. |

Huỷ không bao giờ ghi đè một run đã chốt: huỷ một run vừa kết thúc cùng lúc sẽ
trả `409 NOT_CANCELLABLE` và run giữ nguyên kết quả. Run bị huỷ trong lúc harness
đang phân loại một lời gọi cần duyệt sẽ không bị chuyển sang chờ duyệt, và không
có approval nào được tạo cho nó. Chuyển trạng thái có điều kiện sang `awaiting_approval`
và hai lần insert approval được commit trong cùng một transaction. Nếu một insert
thất bại, cả ba thao tác rollback; đường đồng bộ giữ run đang chạy để cơ chế cách ly
run quá hạn xử lý, còn queue worker ghi nhận lỗi bằng cơ chế hiện có. Lệnh huỷ đến
sau bước chuyển trạng thái phải chờ transaction, không thấy approval mới tạo một nửa.

Lỗi của run và tool call nêu tên lỗi nhưng không bao giờ chứa giá trị của câu
lệnh database bị lỗi: chúng có dạng `Database query failed (SQLSTATE <code>):
<thông báo của driver>`.

## Đa tenant

Hàng đợi và thông tin xác thực provider dùng chung toàn deployment. Mỗi job giữ
`siteId`, định danh run/goal, principal và giới hạn quản trị. Các thao tác DB
trong worker dùng chung vẫn giới hạn theo tenant; principal được phân giải
theo tenant trong payload. Binding và tên queue khác nhau giữa các profile
để staging không tiêu thụ job production.

## Kiểm chứng

Test hồi quy bao phủ việc bỏ qua field trong PATCH, truyền và thực thi budget,
cô lập hai tenant, xác nhận/retry từng message, thiếu
binding và sự đầy đủ của provider. Suite PostgreSQL dùng `DATABASE_URL` và phải
chạy trên DB kiểm thử có thể xoá:

```bash
pnpm -F @lumibase/cms exec vitest run src/services/__tests__/p1-governance.db.integration.test.ts
pnpm -F @lumibase/cms exec vitest run src/services/__tests__/agent-run-recovery.db.integration.test.ts
pnpm -F @lumibase/cms exec vitest run src/__tests__/cloudflare-agent-queue.test.ts
pnpm -F @lumibase/runtime exec vitest run src/__tests__/cloudflare-agent-queue.test.ts
```

Build dry-run kiểm tra đóng gói và cấu hình. Nó không xác nhận
queue production, secret và kết nối Hyperdrive đã được thiết lập.


## Khôi phục kết quả chưa xác định và truy vết yêu cầu

Thời hạn kỹ năng 30 giây chỉ dừng chờ, không dừng trình xử lý bên dưới. Run hết
thời gian lưu `metrics.outcomeUnknown: true` trước khi trả về
`EXECUTION_OUTCOME_UNKNOWN`. Công cụ vẫn có thể hoàn tất ghi dữ liệu sau đó. Thử
lại và tiếp tục phê duyệt trả `RUN_OUTCOME_UNKNOWN`; hủy không thể hoàn tác một
lệnh ghi đã gửi. Nếu không lưu được cờ hoặc tiến trình dừng đột ngột, bản ghi
lời gọi công cụ đang chạy cũng ngăn phát lại. Kiểm tra nội dung, phiên bản, biên
nhận nhà cung cấp và lời gọi công cụ trước khi tạo công việc mới; không coi trạng
thái này là đã hoàn tác.

Dùng mã yêu cầu HTTP không chứa nội dung để tìm `goal.metadata.requestId` và
`run.metrics.requestId`, rồi theo mã run qua công cụ, phê duyệt, artifact, đánh
giá và phiên bản. Lần thử lại giữ `retryOfRunId` và `metrics.originRequestId`, ghi
mã yêu cầu mới vào hoạt động thử lại và tác vụ hàng đợi. Mã có ký tự ngoài chữ
cái, chữ số, `_`, `-` hoặc dài hơn 64 ký tự sẽ bị bỏ qua; không gửi dữ liệu cá
nhân làm mã yêu cầu.

Đầu vào/đầu ra truy vết che khóa thông tin xác thực và dữ liệu cá nhân (gồm email,
số điện thoại, địa chỉ), cùng địa chỉ email trong văn bản. Lỗi cơ sở dữ liệu giữ
SQLSTATE nhưng bỏ tham số truy vấn và chi tiết từ driver. Đây là bảo vệ nhiều lớp,
không phải bộ phân loại mọi thông tin cá nhân trong văn xuôi: tránh đưa bí mật và
dữ liệu cá nhân vào tiêu đề mục tiêu tự do hoặc mã yêu cầu. Đầu vào đã che không
thể phát lại an toàn; hãy tạo yêu cầu mới đã kiểm tra với các giá trị cần thiết.

Nhãn metric agent và công cụ dùng tập hữu hạn; tên lạ gộp vào `custom`, lý do và
trạng thái lạ vào `other`. Công cụ sinh nội dung ghi số token nhà cung cấp nếu có,
nếu không dùng ước lượng từ văn bản. Chỉ xuất USD ước tính khi có đủ số token nhà
cung cấp và cả hai giá tùy chọn không âm `LLM_PRICE_INPUT_PER_MTOK` và
`LLM_PRICE_OUTPUT_PER_MTOK` (USD mỗi triệu token). Cấu hình giá theo mô hình đang
chọn; thiếu giá nghĩa là chưa biết chi phí, không phải bằng không. Các bộ đếm công
cụ này không đại diện mọi cuộc gọi trò chuyện/lập kế hoạch hay hóa đơn nhà cung
cấp. Luồng quyết định phê duyệt dùng chung ghi độ trễ qua các điểm vào agent,
Copilot và reviewer. Bộ đếm nằm trong tiến trình và khởi tạo lại khi tiến trình
khởi động lại.
