---
version: 2
lastUpdated: 2026-10-08T14:15:38.469Z
sourceLang: en
translatedFrom: en
sourceHash: f7df31416aa1c0f0
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-08T14:15:38.469Z
codeVerifiedHash: f7df31416aa1c0f0
codeVerifiedClaims: 6
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
pnpm exec wrangler queues create lumibase-agent-runs-production
pnpm run deploy:production
```

Mỗi consumer dùng batch size 1, batch timeout 1 giây, ba lần retry,
và hàng đợi dead-letter có hậu tố `-dlq`. Cần theo dõi hàng đợi dead-letter;
lỗi giao nhận không chứng minh skill bị gián đoạn chưa tạo side effect.
Queue handler cần `HYPERDRIVE`; môi trường local có thể dùng `DATABASE_URL`
khi `LUMIBASE_ENV=development`. Cấu hình cùng bộ secret LLM và mã hoá
như đường thực thi đồng bộ. Worker nhận các provider cache, search, queue và key
từ runtime Cloudflare.

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
pnpm -F @lumibase/cms exec vitest run src/__tests__/cloudflare-agent-queue.test.ts
pnpm -F @lumibase/runtime exec vitest run src/__tests__/cloudflare-agent-queue.test.ts
```

Build dry-run kiểm tra đóng gói và cấu hình. Nó không xác nhận
queue production, secret và kết nối Hyperdrive đã được thiết lập.
