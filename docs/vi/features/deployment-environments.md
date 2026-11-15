---
version: 2
sourceLang: en
lastUpdated: 2026-11-15T08:36:24.853Z
translatedFrom: en
sourceHash: cc561dbc1dc254c4
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T08:36:24.853Z
codeVerifiedHash: cc561dbc1dc254c4
codeVerifiedClaims: 30
---

# Môi trường triển khai, phân quyền & promote

> Quyết định **ai** được deploy **vào đâu**. Gán các deployment target vào môi trường (`preview`, `staging`, `production`, hoặc môi trường do bạn đặt), cấp `deploy:trigger:<env>` theo vai trò, promote một bản build staging đã kiểm chứng lên production, và đặt production sau một bước phê duyệt của con người mà chính người yêu cầu không thể tự duyệt.

Xây trên [Deployment Integrations](./deployment-integrations.md) (target, provider, trạng thái). Service: `apps/cms/src/services/deployment/release-service.ts` · Bản đồ môi trường: `apps/cms/src/services/deployment/environments.ts` · Mount tại `/api/v1/deployments`.

## 1. Mô hình

- **Môi trường (environment)** — một vị trí có tên (`key`, `name`) gán với một hoặc nhiều deployment target (`targetIds`). Deploy một môi trường là deploy mọi target nó gán.
- **`requiresApproval`** — kích hoạt hoặc promote **vào** môi trường này không bao giờ dispatch ngay khi yêu cầu. Nó tạo một approval đang chờ; không có gì tới provider cho đến khi một người khác phê duyệt.
- **`promotesTo`** — môi trường mà `POST /environments/:key/promote` đưa bản build sẵn sàng mới nhất của môi trường này vào (mặc định `staging → production`).

Bản đồ được lưu theo site trong settings key `deployment.environments` (chỉ site admin được ghi settings). Giá trị mặc định, dùng cho đến khi admin lưu một bản đồ:

| key | requiresApproval | promotesTo | targets |
|---|---|---|---|
| `preview` | không | — | không có |
| `staging` | không | `production` | không có |
| `production` | **có** | — | không có |

Mặc định không target nào được gán, nên một site chưa từng cấu hình môi trường hoạt động y như trước. Một bản đồ đã lưu nhưng không hợp lệ **không** bị thay bằng giá trị mặc định: mọi đường deploy trả `ENVIRONMENTS_INVALID` cho đến khi admin sửa, vì lặng lẽ quay về mặc định có thể gỡ một production target ra khỏi cổng phê duyệt của nó.

## 2. Capability

Quyền deploy dùng chính ngôn ngữ policy hiện có, giống cách `ai:decide` làm: một permission row trên pseudo-collection dành riêng `lumibase_deploy:<scope>`. `<scope>` là một key môi trường, một id deployment target, hoặc `*`.

| Permission row | Capability | Cho phép |
|---|---|---|
| `lumibase_deploy:<scope>` · `create` | `deploy:trigger:<scope>` | kích hoạt / promote vào scope (hoặc gửi yêu cầu, khi cần phê duyệt) |
| `lumibase_deploy:<scope>` · `update` | `deploy:approve:<scope>` | phê duyệt hoặc từ chối các deploy đang chờ của môi trường đó |
| `lumibase_deploy:*` · `create` / `update` | `deploy:trigger:*` / `deploy:approve:*` | mọi môi trường và target |

Được suy ra trong `capabilitiesFromPermissionBundle` (`apps/cms/src/services/effective-capability-service.ts`). Chỉ row khớp chính xác mới tính — không row policy wildcard nào sinh ra capability deploy — và một row deploy không bao giờ sinh ra capability item. Trong Studio, **Access → Policies** liệt kê chúng ở nhóm **Deployments**.

Quy tắc (`canTriggerEnvironment`, `canTriggerTarget`, `canApproveEnvironment`):

- Kích hoạt một môi trường cần `deploy:trigger:*`, `deploy:trigger:<env>`, hoặc `deploy:trigger:<targetId>` trên **mọi** target nó gán.
- Kích hoạt trực tiếp một target cần `deploy:trigger:*`, `deploy:trigger:<targetId>`, hoặc key của bất kỳ môi trường nào chứa nó. Nếu một trong các môi trường đó cần phê duyệt thì kích hoạt trực tiếp cũng bị chặn (môi trường chặt nhất thắng) — `POST /targets/:id/deploy` không thể vượt cổng.
- Promote là deploy **vào môi trường đích**: cần quyền trigger trên môi trường đích.
- Site admin có mọi capability deploy. Admin vẫn chịu `requiresApproval` và vẫn không thể tự duyệt yêu cầu của mình.
- Publishable API key và frontend session không bao giờ có capability deploy, dù policy nói gì.

Người gọi không có capability deploy nào nhận `403` trên mọi route deployments, như trước. CRUD target, bản đồ môi trường và build log vẫn chỉ dành cho site admin.

### Ví dụ: Editor và Release manager

| Vai trò | Permission rows | Staging | Production |
|---|---|---|---|
| Editor | `lumibase_deploy:staging` create, `lumibase_deploy:production` create | deploy ngay (`201`) | yêu cầu được giữ chờ (`202`) |
| Staging editor | `lumibase_deploy:staging` create | deploy ngay | `403` |
| Release manager | `lumibase_deploy:production` update | `403` | duyệt yêu cầu của người khác |

## 3. Cổng phê duyệt

Một yêu cầu bị chặn được lưu trong bảng HITL approval của site `lumibase_ai_approvals` (agent `lumibase-deployments`, skill `deploy:trigger` hoặc `deploy:promote`), xem `apps/cms/src/services/deployment/deploy-approvals.ts`. Các row này không phải AI skill, nên hộp duyệt AI không liệt kê và không quyết định chúng; chúng chỉ được quyết định qua `/deployments/approvals`.

Khi quyết định (`DeploymentReleaseService.decide`):

1. Người quyết định phải là một người đã đăng nhập (`HUMAN_APPROVER_REQUIRED` với API key hoặc agent).
2. Người quyết định không được là người yêu cầu (`SELF_APPROVAL_FORBIDDEN`). Người yêu cầu được **từ chối** (rút lại) yêu cầu của chính mình.
3. Người quyết định cần `deploy:approve:<env>` hoặc `deploy:approve:*`.
4. Một approval hết hạn sau 7 ngày (`APPROVAL_EXPIRED`).
5. Kế hoạch được đối chiếu với bản đồ môi trường hiện tại; target mà admin đã gỡ kể từ lúc yêu cầu sẽ không được deploy, và nếu không còn target nào thì approval thất bại (`PLAN_STALE`).
6. Quyền của người yêu cầu được resolve lại; người yêu cầu bị hạ quyền sau khi gửi khiến approval thất bại (`REQUESTER_REVOKED`).
7. Một lần claim nguyên tử `pending → deciding` bảo đảm hai người duyệt bấm cùng lúc chỉ dispatch một lần.

Trạng thái: `pending`, `deciding`, `approved`, `rejected`, `expired`, `failed`.

## 4. Promote

`POST /environments/staging/promote` lấy deployment `ready` mới nhất của các target staging (hoặc deployment được chỉ định qua `deploymentId`) và đưa nó tới mọi target production (`DeploymentService.promote`):

- **native** — target đích là cùng project của provider và adapter hỗ trợ promote: đúng bản build đó lên live, không build lại (Vercel `POST /v10/projects/:id/promote/:deploymentId`, Netlify khôi phục deploy).
- **retrigger** — mọi trường hợp khác: build mới cùng commit (Vercel ghim `gitSource.sha`) hoặc cùng branch (Netlify build theo branch).

Deployment được promote ghi `triggerSource: promote`, và chế độ nằm trong audit event `deployment.promoted`.

## 5. API

Mọi response dùng `{ data }` / `{ errors }`.

| Method & path | Ai | Kết quả |
|---|---|---|
| `GET /deployments/access` | có bất kỳ quyền deploy nào | `canTrigger` / `canApprove` của người gọi theo từng môi trường |
| `GET /deployments/environments` | có bất kỳ quyền deploy nào | bản đồ môi trường |
| `PUT /deployments/environments` | site admin | thay bản đồ (`{ environments: [...] }`; id target không tồn tại → `UNKNOWN_TARGET`) |
| `POST /deployments/environments/:key/deploy` | `deploy:trigger:<key>` | `201` `{ status: 'dispatched', results }` hoặc `202` `{ status: 'pending_approval', approval }` |
| `POST /deployments/environments/:key/promote` | quyền trigger trên môi trường đích | như trên |
| `POST /deployments/targets/:id/deploy` | quyền trigger trên target hoặc môi trường chứa nó | `201` deployment, hoặc `202` approval đang chờ khi bị chặn |
| `GET /deployments/approvals?status=pending` | có bất kỳ quyền deploy nào | các approval kèm `canDecide` cho người gọi (`status=all` để xem lịch sử) |
| `POST /deployments/approvals/:id/decide` | `deploy:approve:<env>`, không phải người yêu cầu | `{ decision: 'approved' \| 'rejected', reason? }` |

## 6. Audit

Mỗi bước ghi một audit event: `deployment.trigger.denied`, `deployment.approval.requested`, `deployment.approval.approved`, `deployment.approval.rejected`, `deployment.approval.refused` (tự duyệt, thiếu quyền, người yêu cầu bị thu hồi quyền, kế hoạch lỗi thời), `deployment.approval.expired`, `deployment.promoted`, `deployment.triggered`, `deployment.environments.updated`.

## 7. Ghi chú phạm vi

- Cổng áp dụng cho các deploy mà một người hoặc API caller yêu cầu qua deployments API. Agent tool `triggerDeployment` giữ cổng HITL riêng của nó (`deployments:write`, phê duyệt dưới mức autopilot), và các operation Flow `deploy:trigger` chạy theo cấu hình của site admin.
- Một row `deciding` bị bỏ lại do process crash không được dọn tự động; nó nằm ngoài danh sách đang chờ và yêu cầu phải được gửi lại.
