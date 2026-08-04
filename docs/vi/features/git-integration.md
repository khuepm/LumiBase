---
title: Git Integration (GitHub / GitLab)
version: 1
lastUpdated: 2026-07-28T10:20:15.614Z
sourceLang: en
translatedFrom: en
sourceHash: 00b92c1afa81ad18
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:20:15.614Z
codeVerifiedHash: 00b92c1afa81ad18
codeVerifiedClaims: 10
---

# Git Integration (GitHub / GitLab)

Nối repository GitHub hoặc GitLab vào một site LumiBase để theo dõi pull request
và CI, xem/lưu CI log, đăng ngược lại một status kiểm tra nội dung, reconcile các
content intent khai báo (GitOps), và chạy các môi trường preview tạm thời theo
từng PR (opt-in). Spec: `.kiro/specs/git-integration/`.

## 1. Mục tiêu & mô hình

- **Theo tenant:** một site nối một hoặc nhiều repo; mọi row đều có `site_id`.
- **Không phụ thuộc provider:** business logic phụ thuộc vào interface
  `GitProvider`; các adapter `GitHubProvider` / `GitLabProvider` chỉ dùng `fetch`
  (REST), nên chúng chạy được trên cả Cloudflare Workers và Docker qua runtime
  chung.
- **Earned autonomy:** một agent role `git-sync` được seed ở mức thận trọng L1
  (PROPOSE) khi kết nối lần đầu; việc tạo goal vẫn chỉ dành cho planner.

## 2. Auth

- **App install** (`authMethod: 'app'`) — GitHub App / GitLab App; installation
  token được mint theo yêu cầu (GitHub App JWT là RS256 trên một key PKCS#8).
- **OAuth / PAT** (`authMethod: 'pat'`) — người dùng dán một token, hoặc cấp phép
  qua luồng OAuth (`GET /:id/oauth/authorize` trả về một URL; callback công khai
  được ràng vào một `state` trong cache dùng một lần).

## 3. Bảo mật token

- Access token và webhook secret được mã hoá at rest qua `CryptoService`
  (AES-GCM), với AAD ràng vào `{ siteId, integrationId, field }` — một ciphertext
  không thể replay sang site khác hay field khác. Cần có `ENCRYPTION_KEY`.
- Token không bao giờ được API trả về (chỉ có boolean `hasToken`) và không bao giờ
  bị log (dùng fingerprint `maskToken`).

## 4. Webhook & CI

- Receiver công khai `POST /api/v1/integrations/git/webhook/:provider/:siteId/:integrationId`.
  GitHub được verify bằng HMAC-SHA256 (`X-Hub-Signature-256`), GitLab bằng shared
  token (`X-Gitlab-Token`), so sánh theo constant time. Request chưa verify nhận
  `401 INVALID_SIGNATURE` trước khi có bất kỳ state nào bị chạm tới. Event được
  log idempotent theo `(provider, delivery_id)` và xử lý async vào cache PR/CI.
  Một CI run thất bại sẽ ghi một `agent_incident` + audit `git_ci_failed`.
- CI log được lấy qua provider và cache trong blob storage của runtime, nên vẫn
  xem được sau khi provider đã hết hạn bản gốc.

## 5. GitOps

`POST /:id/gitops/sync` đọc `lumibase/intents.json` từ repo, upsert từng định
nghĩa vào `content_intents` (qua `IntentService`), rồi chạy một lượt quét drift +
reconcile để các item ngoài policy trở thành agent goal; provenance được ghi theo
từng intent. Việc apply schema (collection/field) qua HITL harness là bước tiếp
theo.

## 6. Môi trường preview (opt-in)

Khi `sync_config.preview = true`, một PR được mở sẽ provision một site tạm thời
dẫn xuất (`${siteId}__pr-${number}`), được seed bằng một bản copy các
collection/field/item/page của site gốc, phục vụ tại
`/api/v1/deliver/page/${ephemeralSiteId}/…`. Nó refresh khi có push và được dọn
sạch (cascade-delete) khi close/merge, kèm một lượt cleanup theo TTL.

## 7. Multi-tenancy

**Dùng chung cho cả deployment** (định danh/cấu hình của server, không phải dữ
liệu tenant):

- `ENCRYPTION_KEY` (KEK để mã hoá token), credential OAuth & App `GITHUB_*` /
  `GITLAB_*`, `LUMIBASE_PUBLIC_URL`. Chúng định danh *server/app*, không phải một
  tenant, và không bao giờ mang dữ liệu tenant.

**Cách ly theo tenant (`site_id`):**

- Cả sáu bảng (`lumibase_git_integrations`, `_git_pull_requests`, `_git_ci_runs`,
  `_git_webhook_events`, `_git_preview_envs`, `_git_provenance`) đều có `site_id`;
  mọi `GitIntegrationService` / query đều scope `where(eq(table.siteId, siteId))`;
  cả sáu đều được đăng ký cho RLS `site_isolation` trong
  `packages/database/migrations/rls-policies.sql`.
- **Định tuyến webhook:** receiver công khai nhúng `siteId` + `integrationId` vào
  URL và set biến session RLS thành `siteId` đó trước khi đọc — nó chỉ có thể
  chạm tới row của đúng một site, và chữ ký bằng secret riêng theo từng
  integration là cửa xác thực.
- **Preview:** id của site tạm thời được dẫn xuất từ `siteId` gốc
  (`${siteId}__pr-${n}`); nội dung preview nằm ở row `sites` riêng của nó, cách ly
  khỏi nội dung production của site gốc. Việc provision là một lần ghi *system*
  xuyên site có chủ đích (đọc site gốc dưới context RLS của site gốc, ghi site tạm
  thời dưới context của site tạm thời).
- **Crypto token:** AAD ràng ciphertext vào `{ siteId, integrationId }`, nên một
  row token được copy sang site khác sẽ không giải mã được.

**Cách verify cách ly giữa hai site** (staging, với Postgres):

1. Nối repo R vào site **A** và (riêng biệt) vào site **B**.
2. `GET /api/v1/integrations/git` với `X-Lumi-Site: A` chỉ trả về integration của
   A; không bao giờ của B. Tương tự với `/pull-requests`, `/ci`, `/provenance`.
3. `webhookUrl` của từng integration nhúng `siteId` riêng của nó; hãy gửi một
   webhook đã ký tới URL của A và xác nhận chỉ cache PR/CI của A đổi.
4. Với `sync_config.preview`, mở một PR trên A → site preview `A__pr-N` được tạo;
   xác nhận nó không nhìn thấy được dưới `X-Lumi-Site: B` và nội dung của nó không
   chạm tới item production của A.

Độ phủ tự động: `crypto.test.ts` chứng minh cách ly AAD xuyên site;
`git-service-tenant.test.ts` chứng minh việc map webhook URL / resource theo
site. Phần cách ly list/query giữa hai site có DB thật được verify trên staging
theo các bước ở trên (môi trường CI không có Postgres).

## 8. Ghi chú thiết lập

- **Không có bước setup-wizard / seed / capability flag.** Integration được tạo
  sau khi setup, tại **Studio → Settings → Integrations → Git repositories**.
- **Migration** `0009_git_integration` là additive (`CREATE TABLE IF NOT EXISTS`,
  tiền tố `lumibase_git_*` theo ADR-010) — không backfill. Xem row git-integration
  trong Setup Impact Registry.
- Role `git-sync` được seed lười; grant autonomy L1 của nó được seed ở lần kết nối
  repo đầu tiên (idempotent, không bao giờ ghi đè mức do operator đặt).
