# Design Document — Deployment Integrations (Vercel / Netlify)

## 1. Tổng quan

Năng lực Deployment Integrations cho phép trigger / monitor / debug deployment trên Provider bên ngoài (Vercel, Netlify) từ trong LumiBase. Thiết kế tái sử dụng tối đa các lớp đã ship: Flows engine, runtime abstraction (queue), scheduler pattern, AI Skills registry, Harness/HITL, audit/provenance, và KeyProvider để mã hoá token.

Nguyên tắc thiết kế:

- **Provider adapter pattern** — tách logic riêng từng Provider sau một interface chung; thêm Provider mới = thêm 1 adapter.
- **Tái dụng, không phát minh lại** — outbound HTTP đi qua chính sách SSRF của `http` operation; job nền đi qua `QueueProvider`; poll đi theo pattern `scheduler-worker`.
- **Secret an toàn theo mặc định** — token mã hoá bằng KeyProvider (AES-GCM), không plaintext trong DB, không trả qua API, masking trong log/audit.
- **AI-native có kiểm soát** — deploy là skill rủi ro cao, qua HITL/`ai_approvals` khi autonomy chưa đủ.

## 2. Kiến trúc thành phần

```
apps/cms/src/
  routes/
    deployments.ts              ← REST: targets CRUD, deploy, list/detail, logs, refresh, inbound webhook
  services/
    deployment/
      deployment-service.ts     ← orchestration: create target, trigger, sync status, fetch logs
      providers/
        provider.ts             ← DeploymentProvider interface + registry
        vercel.ts               ← Vercel adapter (Deploy Hook + REST v6/v13)
        netlify.ts              ← Netlify adapter (Build Hook + REST)
      token-vault.ts            ← encrypt/decrypt provider token qua KeyProvider (AES-GCM envelope)
      status-poller.ts          ← queue-driven sweep đồng bộ trạng thái (pattern scheduler-worker)
  services/
    flow-service.ts             ← +registerHandler('deploy:trigger') / ('deploy:status')

packages/
  database/src/schema/
    deployments.ts              ← deployment_targets, deployments (bảng mới)
  ai-skills/src/
    skills.ts                   ← +triggerDeployment, listDeployments, getDeploymentStatus, listDeploymentTargets

apps/studio/src/modules/
  deployments/                  ← list page + detail panel
  settings/deployment-targets-page.tsx  ← cấu hình kết nối (nhập token)
```

## 3. Data model

### 3.1 `deployment_targets`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | text PK | `nanoid()` |
| `siteId` | text NOT NULL | FK, multi-tenancy |
| `provider` | text NOT NULL | `'vercel' \| 'netlify'` |
| `name` | text NOT NULL | tên hiển thị |
| `projectId` | text NOT NULL | Vercel project id / Netlify site id |
| `tokenCiphertext` | text NOT NULL | token đã mã hoá (envelope base64) |
| `tokenKeyId` | text NOT NULL | keyId đã dùng (cho rotation/decrypt) |
| `defaultBranch` | text NULL | nhánh deploy mặc định |
| `productionUrl` | text NULL | URL production để hiển thị |
| `status` | text NOT NULL | `'active' \| 'inactive'` default `'active'` |
| `createdAt` / `updatedAt` | timestamptz | |

Index: `(siteId)`, `(siteId, provider)`.

### 3.2 `deployments`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | text PK | `nanoid()` |
| `siteId` | text NOT NULL | FK |
| `targetId` | text NOT NULL | FK → deployment_targets |
| `provider` | text NOT NULL | denormalized để query nhanh |
| `providerDeploymentId` | text NULL | id deployment phía Provider (match khi poll/webhook) |
| `status` | text NOT NULL | `'queued' \| 'building' \| 'ready' \| 'error' \| 'canceled'` |
| `branch` | text NULL | |
| `commitSha` / `commitMessage` | text NULL | |
| `url` | text NULL | preview/production URL |
| `triggeredBy` | text NULL | userId hoặc runId |
| `triggerSource` | text NOT NULL | `'manual' \| 'auto' \| 'agent'` |
| `errorMessage` | text NULL | |
| `logExcerpt` | text NULL | đoạn cuối log (giới hạn ~16KB), đã mask secret |
| `createdAt` / `updatedAt` | timestamptz | |
| `completedAt` | timestamptz NULL | đặt khi đạt trạng thái cuối |

Index: `(siteId, targetId)`, `(siteId, status)`, `(providerDeploymentId)` — index cuối phục vụ match idempotent khi poll/webhook.

### 3.3 Mapping trạng thái Provider → chuẩn

| Chuẩn LumiBase | Vercel (`deployment.readyState`) | Netlify (`deploy.state`) |
|---|---|---|
| `queued` | `QUEUED`, `INITIALIZING` | `new`, `enqueued` |
| `building` | `BUILDING` | `building`, `uploading`, `processing` |
| `ready` | `READY` | `ready`, `current` |
| `error` | `ERROR` | `error`, `failed` |
| `canceled` | `CANCELED` | `canceled` |

> Bảng map là nguồn sự thật duy nhất, đặt trong adapter từng Provider để dễ kiểm thử và cập nhật theo thay đổi API.

## 4. Provider adapter

```ts
// services/deployment/providers/provider.ts
export interface DeploymentRef {
  providerDeploymentId: string;
  status: DeploymentStatus;       // chuẩn LumiBase
  url?: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  errorMessage?: string;
  completedAt?: Date;
}

export interface DeploymentProvider {
  readonly key: 'vercel' | 'netlify';
  /** Read-only call để verify token khi tạo/sửa target (Req 1.4). */
  verifyToken(token: string, projectId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Trigger build/deploy; trả ref nếu Provider cung cấp id ngay. */
  trigger(token: string, target: DeploymentTarget, opts: TriggerOptions): Promise<DeploymentRef>;
  /** Lấy trạng thái hiện tại của 1 deployment (cho poller/refresh). */
  getStatus(token: string, target: DeploymentTarget, providerDeploymentId: string): Promise<DeploymentRef>;
  /** Lấy build log (cho debug). */
  getLogs(token: string, target: DeploymentTarget, providerDeploymentId: string): Promise<string>;
  /** Verify chữ ký inbound webhook (Req 7.2). */
  verifyWebhook(req: { headers: Record<string,string>; rawBody: string }, secret: string): boolean;
  /** Parse payload inbound webhook → DeploymentRef. */
  parseWebhook(rawBody: string): DeploymentRef | null;
}

const registry = new Map<string, DeploymentProvider>();
export function registerProvider(p: DeploymentProvider) { registry.set(p.key, p); }
export function getProvider(key: string): DeploymentProvider | undefined { return registry.get(key); }
```

- **Vercel adapter**: trigger qua Deploy Hook URL (`POST https://api.vercel.com/v1/integrations/deploy/...`) hoặc REST `POST /v13/deployments`; status qua `GET /v13/deployments/:id`; logs qua `GET /v2/deployments/:id/events`. Auth: `Authorization: Bearer <token>`.
- **Netlify adapter**: trigger qua Build Hook (`POST https://api.netlify.com/build_hooks/:id`) hoặc REST `POST /api/v1/sites/:site_id/builds`; status qua `GET /api/v1/sites/:site_id/deploys/:deploy_id`; logs qua `GET .../log`. Auth: `Authorization: Bearer <token>`.

Mọi outbound URL đi qua `validateOutboundUrl()` (SSRF guard) và `fetch` với `AbortSignal.timeout(30_000)` — đồng nhất với operation `http` ở `flow-service.ts:92`.

## 5. Token vault (mã hoá)

Tái dụng `KeyProvider` (AES-GCM) đã có trong runtime — KHÔNG tự cài crypto mới.

```ts
// services/deployment/token-vault.ts
export async function encryptToken(keys: KeyProvider, plaintext: string): Promise<{ ciphertext: string; keyId: string }> {
  const { keyId, key } = await keys.getActiveKey();          // base64 raw AES key
  // AES-GCM: iv(12) || ciphertext || tag → base64 envelope, prefix keyId
  // ...dùng WebCrypto subtle.encrypt; chạy được trên cả CF Workers lẫn Node
  return { ciphertext, keyId };
}
export async function decryptToken(keys: KeyProvider, ciphertext: string, keyId: string): Promise<string> {
  const key = await keys.getKey(keyId);                       // hỗ trợ retired key (rotation)
  // subtle.decrypt → plaintext
}
```

- Lấy `runtime.keys` từ `c.get('runtime')` — không import binding CF trực tiếp.
- Token chỉ giải mã **ngay trước khi gọi Provider**, không lưu plaintext, không log.
- Rotation: token cũ vẫn giải mã được nhờ `getKey(keyId)` (retired keys), mã hoá mới dùng `getActiveKey()`.

## 6. Luồng thực thi

### 6.1 Tạo target (Req 1)
```
POST /api/v1/deployment-targets
  → verify token với Provider (verifyToken)   [Req 1.4]
  → encryptToken(runtime.keys, token)          [Req 1.2]
  → insert deployment_targets (ciphertext + keyId)
  → audit: target.created (mask secret)
  → response KHÔNG chứa token                  [Req 1.3]
```

### 6.2 Trigger thủ công (Req 2)
```
POST /api/v1/deployment-targets/:id/deploy
  → load target (filter siteId)
  → rate-limit check                            [Req 9.5]
  → decryptToken → provider.trigger(...)        [SSRF guard + timeout]
  → insert deployments(status=queued, providerDeploymentId, triggerSource=manual)
  → audit: deploy.triggered
  → (Provider lỗi → status=error + errorMessage, trả lỗi)  [Req 2.3]
```

### 6.3 Đồng bộ trạng thái (Req 3)
- **Primary**: `status-poller.ts` đăng ký trên `QueueProvider` (const `DEPLOYMENT_POLL_QUEUE`), tick định kỳ:
  ```
  sweepPending(siteId?):
    select deployments where status in (queued, building)
    for each (best-effort, lỗi 1 cái không vỡ sweep):     [Req 9.4]
      provider.getStatus(...) → conditional UPDATE theo providerDeploymentId  [idempotent, Req 3.4]
      nếu trạng thái cuối → set completedAt + emit event   [Req 3.6]
  ```
- **Fallback đồng bộ**: `POST /api/v1/deployments/:id/refresh` khi không có queue. [Req 3.5]
- **Mô hình giống `scheduler-worker`**: tick qua queue + safety-net sweep, conditional UPDATE guard bằng trạng thái nguồn.

### 6.4 Debug log (Req 4)
```
GET /api/v1/deployments/:id/logs
  → decryptToken → provider.getLogs(...)
  → mask secret (audit masking) → trả về
khi status=error: poller/refresh đã lưu logExcerpt + errorMessage  [Req 4.2]
```

### 6.5 Auto-deploy (Req 5)
- Đăng ký Flow handler: `registerHandler('deploy:trigger', handler)` trong `flow-service.ts`, dùng chung `DeploymentService.trigger()`.
- Flow `triggerType:'event'` (collection + `items.publish`) → node `deploy:trigger` với `options.targetId`.
- `db`/`siteId`/`runtime` đến qua `ctx.env` (giống `drift-scan` handler hiện có).
- Debounce/coalescing: cấu hình `coalesceWindowMs` trên target; trong cửa sổ, gộp về 1 deploy. [Req 5.4]

### 6.6 Skill agent + HITL (Req 6)
- Skills khai báo trong registry với `requiredCapabilities`.
- `triggerDeployment` đánh dấu rủi ro cao → Harness tạo `ai_approvals` khi autonomy < autopilot (rule #4 CLAUDE.md).
- Thực thi sau approval → `triggerSource='agent'`, `triggeredBy=runId`, ghi provenance/audit.

### 6.7 Inbound webhook (Req 7, optional)
```
POST /api/v1/deployments/webhook/:provider
  → provider.verifyWebhook(headers, rawBody, secret)   [401 nếu fail, Req 7.2]
  → provider.parseWebhook → match deployments theo providerDeploymentId
  → conditional UPDATE (idempotent với poller)          [Req 7.3]
```

## 7. API surface

| Method | Path | Capability | Mô tả |
|---|---|---|---|
| GET | `/api/v1/deployment-targets` | `deployments:read` | list targets |
| POST | `/api/v1/deployment-targets` | `deployments:write` | tạo (verify+encrypt token) |
| PATCH | `/api/v1/deployment-targets/:id` | `deployments:write` | sửa (re-verify nếu đổi token) |
| DELETE | `/api/v1/deployment-targets/:id` | `deployments:write` | xoá |
| POST | `/api/v1/deployment-targets/:id/deploy` | `deployments:write` | trigger thủ công |
| GET | `/api/v1/deployments` | `deployments:read` | list (filter target/status, paginate) |
| GET | `/api/v1/deployments/:id` | `deployments:read` | chi tiết |
| GET | `/api/v1/deployments/:id/logs` | `deployments:read` | build log |
| POST | `/api/v1/deployments/:id/refresh` | `deployments:read` | đồng bộ trạng thái ngay |
| POST | `/api/v1/deployments/webhook/:provider` | (chữ ký) | inbound status webhook |

Tất cả tuân `{ data, meta? }` / `{ errors }`, header `X-Lumi-Site`, Bearer auth.

## 8. Studio UI

- `modules/deployments/deployments-page.tsx` — bảng deployment, badge trạng thái (lucide icons), filter target/status, nút "Deploy now" theo target, nút refresh/log.
- `modules/deployments/deployment-detail.tsx` — panel chi tiết: branch/commit/url, timeline trạng thái, log (`logExcerpt` + nút "Tải full log").
- `modules/settings/deployment-targets-page.tsx` — CRUD target; ô nhập token chỉ ghi, không hiển thị lại; nút "Test connection" gọi verify.
- Cập nhật trạng thái: client poll nhẹ (React Query refetchInterval khi có deployment đang `building`) — đủ cho v1; inbound webhook giảm độ trễ nếu bật.

## 9. Bảo mật & độ bền (tóm tắt mapping)

- **SSRF + timeout** mọi outbound (Req 9.2) — `validateOutboundUrl` + `AbortSignal.timeout`.
- **Multi-tenancy** (Req 9.1) — mọi query filter `siteId`; RLS như các bảng domain khác.
- **RBAC** (Req 9.3) — gate `deployments:read/write`.
- **Token** — mã hoá AES-GCM, không plaintext/return/log; masking audit.
- **Idempotency & partial failure** (Req 9.4) — conditional UPDATE; lỗi 1 deployment không vỡ sweep.
- **Rate limit** (Req 9.5) — giới hạn trigger thủ công mỗi target.

## 10. Kiểm thử

- **Unit**: mapping trạng thái từng Provider; token-vault encrypt→decrypt round-trip (kể cả retired key); SSRF guard chặn URL nội bộ; rate-limit; idempotent sweep (chạy 2 lần không đổi kết quả).
- **Integration**: target CRUD (token không lộ trong response); trigger → tạo deployment; poller cập nhật trạng thái (mock Provider); inbound webhook verify chữ ký (reject sai chữ ký).
- **HITL**: agent gọi `triggerDeployment` dưới ngưỡng autonomy → tạo `ai_approvals`, không deploy ngay.
- **Multi-tenancy**: site A không đọc/ghi được deployment của site B.

## 11. Rủi ro & quyết định mở

- **Polling vs webhook**: v1 mặc định polling (đơn giản, không phụ thuộc cấu hình Provider); inbound webhook là tuỳ chọn giảm tải/độ trễ. — *Chốt: polling primary.*
- **Lưu full log**: v1 chỉ lưu `logExcerpt` (đoạn cuối) để giới hạn dung lượng; full log lấy theo yêu cầu từ Provider. — *Chốt.*
- **Provider mới**: adapter pattern sẵn sàng; Cloudflare Pages/AWS Amplify để phiên bản sau. — *Out of scope v1.*
- **TODO(owner)**: xác nhận endpoint logs chính xác của Vercel/Netlify theo phiên bản API tại thời điểm implement (API có thể đổi). — chủ: dev thực thi.
