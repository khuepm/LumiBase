---
version: 1
lastUpdated: 2026-07-28T10:20:15.340Z
sourceLang: en
translatedFrom: en
sourceHash: 0ba8c0326e531abc
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:20:15.340Z
codeVerifiedHash: 0ba8c0326e531abc
codeVerifiedClaims: 32
---

# Deployment Integrations (Vercel / Netlify)

> Kích hoạt, theo dõi và debug deployment trên các nhà cung cấp hosting bên ngoài (**Vercel**, **Netlify**, hoặc một **HTTP** deploy hook chung) ngay trong LumiBase — không cần nhảy sang dashboard của provider.

Bảng: `deployment_targets`, `deployments` (`packages/database/src/schema/deployments.ts`) · Service: `apps/cms/src/services/deployment/` · Mount tại `/api/v1/deployments`.

## 1. Mục tiêu & mô hình

Mỗi **deployment target** cấu hình một kết nối tới một project trên một provider, scope theo site. Từ target đó bạn kích hoạt build và xem trạng thái mà không cần rời Studio.

- **Trigger** — khởi động một lần build/deploy thủ công, hoặc tự động khi nội dung đổi.
- **Monitor** — theo dõi trạng thái (`queued → building → ready/error`) gần như realtime.
- **Debug** — xem build log, thông báo lỗi, branch/commit, và link tới deployment trên provider.

Một target = một `(site, provider, project)`. Một **deployment** = một lần build/deploy trên target đó, kèm trạng thái đã chuẩn hoá theo LumiBase và một đoạn trích log.

- **Edge-native:** các adapter provider chỉ dùng `fetch` (REST) — chúng chạy được trên cả Cloudflare Workers và Docker thông qua runtime chung.
- **Multi-tenant:** mọi row `deployment_targets` / `deployments` đều có `site_id`, và mọi query đều scope theo nó.

## 2. Providers

| Provider | `provider` | Trigger | Trạng thái |
|---|---|---|---|
| Vercel | `vercel` | Deploy Hook / REST `POST /deployments` | Poll + webhook vào |
| Netlify | `netlify` | Build Hook / REST | Poll + webhook vào |
| Generic HTTP | `http` | Bất kỳ URL deploy-hook nào (`POST`) | Poll ở nơi endpoint phơi ra trạng thái |

Các adapter nằm ở `apps/cms/src/services/deployment/providers/`. Mỗi provider map state riêng của nó vào enum `status` đã chuẩn hoá: `queued | building | ready | error | canceled`.

## 3. Bảo mật token

API token của provider **không bao giờ được lưu ở dạng plaintext**. Khi tạo, token được mã hoá qua **KeyProvider** của runtime (ADR-002) và lưu thành `token_ciphertext` + `token_key_id`. Nó chỉ được giải mã tại thời điểm gọi để nói chuyện với provider, và **không bao giờ được API trả về** — `DeploymentTargetResource` trả cho client bỏ hẳn token ra ngoài.

## 4. Sync trạng thái

Hai đường bổ trợ nhau giữ cho trạng thái deployment luôn mới:

- **Status poller** — một cron 30s (`apps/cms/src/services/deployment/status-poller.ts`, đăng ký trong `serve.ts`) quét mọi deployment chưa ở trạng thái cuối và sync nó từ provider. Mỗi lần sync là một conditional update có bảo vệ (chỉ đổi `queued`/`building`) và một lỗi provider đơn lẻ không bao giờ làm gián đoạn cả vòng quét — chạy lại là no-op.
- **Webhook vào** — `POST /api/v1/deployments/webhook/:provider` (public, trước auth) nhận các event trạng thái do provider đẩy tới. Nó cố ý nằm ngoài bề mặt đã xác thực vì provider xác thực bằng cách **ký body request**, không phải bằng bearer token; nó vẫn chạy `withTenant` + `withDb`. Chữ ký được verify thật trên raw body qua Web Crypto: **Vercel** dùng HMAC-SHA1 (`x-vercel-signature`), **Netlify** dùng JWS/HS256 (`x-webhook-signature`), so sánh theo constant time. Secret chung được đọc từ setting theo site `deployment.webhook.<provider>` (giá trị `{ "secret": "…" }`) — **không bao giờ** từ một request header. Nếu chưa cấu hình secret, mọi request webhook đều bị từ chối (`401 INVALID_SIGNATURE`); trạng thái vẫn sync được qua poller.

## 5. REST API

Toàn bộ route nằm dưới `/api/v1/deployments`, trên bề mặt đã xác thực + scope theo tenant (`withAuth`).

| Method & path | Mục đích |
|---|---|
| `GET /targets` | Liệt kê target đã cấu hình (bỏ token) |
| `POST /targets` | Tạo target (token được mã hoá khi ghi) |
| `PATCH /targets/:id` | Cập nhật target |
| `DELETE /targets/:id` | Xoá target |
| `POST /targets/:id/deploy` | Kích hoạt một lần build/deploy |
| `GET /` | Liệt kê deployment (filter theo `targetId` / `status`) |
| `GET /:id` | Lấy một deployment |
| `GET /:id/logs` | Lấy build log |
| `POST /:id/refresh` | Buộc sync trạng thái từ provider |

SDK (`@lumibase/sdk`): `client.deployments.targets.{list,create,update,delete,deploy}` và `client.deployments.{list,get,logs,refresh}`, có type `DeploymentTargetResource` / `DeploymentResource`.

## 6. Auto-deploy qua Flows

Đường "tự deploy khi nội dung đổi" được nối qua engine Flows, không phải một trigger riêng. Hai operation được đăng ký trên flow runtime (`apps/cms/src/services/flow-service.ts`):

| Operation | Options | Tác dụng |
|---|---|---|
| `deploy:trigger` | `targetId` (bắt buộc), `branch?`, `reason?` | Kích hoạt deploy qua `DeploymentService` chung (cùng đường, cùng guard và audit như API thủ công). Ghi `triggerSource='auto'` và liên kết `runId` của flow để có provenance. |
| `deploy:status` | `deploymentId` (bắt buộc) | Sync và trả về trạng thái của một deployment để flow có thể phân nhánh theo nó. |

Nối auto-deploy bằng cách tạo một Flow với `triggerType: 'event'` (ví dụ một item được publish trong một collection) mà graph của nó có một node `deploy:trigger` trỏ tới một target. Cả hai operation đều bind vào runtime: `db`, `siteId`, **KeyProvider** (`keys`) và `runId` được môi trường flow run cung cấp (`routes/flows.ts`), nên một lần deploy khởi từ flow dùng lại token đã mã hoá cùng các guard SSRF/audit y như trigger thủ công. Thiếu môi trường hoặc thiếu `targetId`/`deploymentId` thì fail closed kèm lỗi rõ ràng, trước khi có bất kỳ lệnh gọi provider nào.

## 7. AI skills & HITL

Bốn governed skill cho phép AI Copilot vận hành deployment (`packages/ai-skills/src/skills.ts`, handler trong `ai-harness.ts`):

| Skill | Capability | Risk |
|---|---|---|
| `listDeploymentTargets` / `listDeployments` / `getDeploymentStatus` | `deployments:read` | safe |
| `triggerDeployment` | `deployments:write` | **dangerous** → HITL `before_execute` khi dưới mức autopilot |

`triggerDeployment` gây ra side-effect hướng ra ngoài (một lần build trên host bên ngoài), nên nó được phân loại dangerous: dưới mức autonomy autopilot, nó được đưa qua phê duyệt của con người (`ai_approvals`) thay vì thực thi trực tiếp.

Giống các flow operation ở trên, cả bốn skill đều bind vào runtime: handler của chúng dựng một `DeploymentService` scope theo site từ `db`, `siteId` và **KeyProvider** (`keys`), nên mọi nơi khởi tạo harness có thể thực thi skill đều phải truyền `keys` — các đường request (`routes/ai.ts` chat + thực thi approval, `routes/mcp.ts`) lấy nó từ `c.get('runtime').keys`, còn worker `agent-runs` dạng queue (`execution: 'async'`) lấy từ deps của worker. Không có nó, skill fail closed với `DEPLOYMENTS_NOT_CONFIGURED` trước bất kỳ lệnh gọi provider nào. Một tripwire quét source (`apps/cms/src/__tests__/ai-harness-keys-context.test.ts`) làm fail CI nếu một nơi khởi tạo mới bỏ sót nó.

## 8. Studio

Một trang **Settings → Deployments** (`apps/studio/src/modules/settings/deployments-page.tsx`) liệt kê các target và các deployment gần đây, kèm điều khiển để thêm target, kích hoạt deploy, refresh trạng thái và xem log. Nó nằm ở `/settings/deployments` (và `/<adminPath>/settings/deployments` trên các instance có admin path tuỳ chỉnh), truy cập từ nhóm **Integrations** của sidebar settings.

## 9. Ghi chú thiết lập

- **Capabilities:** thêm `deployments:read` / `deployments:write` — cấp chúng cho role admin khi upgrade. (Không có agent role mặc định nào mang `deployments:write`, nên skill `triggerDeployment` chỉ chạy cho caller được cấp tường minh — deploy không bao giờ tự động có sẵn cho agent thông thường.)
- **Không seed:** target do admin tạo sau khi setup; không có giá trị mặc định.
- **RLS:** `lumibase_deployment_targets` và `lumibase_deployments` được cách ly theo site qua `packages/database/migrations/rls-policies.sql` (theo quy ước của dự án, không nằm trong migration tạo bảng).
- **Webhook vào (tuỳ chọn):** để nhận trạng thái do provider đẩy tới, đặt setting theo site `deployment.webhook.<provider>` thành `{ "secret": "<shared secret>" }` và cấu hình cùng secret đó ở webhook của provider. Không có nó, trạng thái chỉ sync qua poller 30s.
- **Các bảng** `lumibase_deployment_targets` và `lumibase_deployments` là phần của migration schema hợp nhất `0000_lumibase_init`.
- Xem spec ở `.kiro/specs/deployment-integrations/` để có đầy đủ requirement và design.
