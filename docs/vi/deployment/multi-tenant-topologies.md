---
version: 1
lastUpdated: 2026-07-12T19:36:40.832Z
sourceLang: en
translatedFrom: en
sourceHash: 949e959f703a293e
mtEngine: manual
syncStatus: translated
---

# Các Topology Triển Khai Đa Tenant

> **Đối tượng:** người vận hành nền tảng và kiến trúc sư giải pháp triển khai LumiBase cho nhiều tenant.
> **Phạm vi:** tenancy ở tầng triển khai — cách bố trí instance CMS, database và network theo tenant. Tenancy ở tầng ứng dụng (RLS, permissions, settings per-site) xem [data model](../data-model.md) và [security docs](../security/user-management.md).

Trong tài liệu này, mọi năng lực đều được gắn nhãn **[Platform]**
(đã hiện thực trong repository, có dẫn chiếu code) hoặc **[Pattern]**
(kiến trúc tham chiếu khuyến nghị, bạn lắp ráp từ năng lực platform
cộng với hạ tầng của riêng bạn).

---

## 1. Thuật ngữ

| Thuật ngữ | Ý nghĩa |
| --- | --- |
| **Tenant** | Một khách hàng/thương hiệu. Map với một dòng **site**; mọi bảng domain đều scope theo `site_id`. |
| **Core layer** | Phần giống hệt nhau cho mọi tenant: CMS image/Worker bundle và schema database dùng chung. Pin theo version release. |
| **Adaptive layer** | Phần khác nhau theo tenant: collections, fields, settings, webhooks, flows, extensions. Được biểu diễn dưới dạng **data/config**, không bao giờ là fork source code. |
| **Cell** | Một deployment tự chứa (CMS + Postgres + cache + storage) phục vụ một hoặc nhiều tenant. |
| **Fleet** | Tập hợp tất cả cell bạn vận hành, quản lý từ một repository khai báo duy nhất. |

Quy tắc thiết kế khiến mọi topology bên dưới hoạt động được: **Core là
artifact có version, Adaptive là config khai báo.** Nếu một yêu cầu của tenant
chỉ có thể đáp ứng bằng cách vá source code, hãy mô hình hóa nó thành extension
hoặc flow (xem `packages/extension-sdk/`) để Core image giữ nguyên trên toàn fleet.

## 2. Các primitive tenancy mà platform cung cấp

Đây là các khối xây dựng mà mọi topology đều ghép từ chúng. **[Platform]**

1. **Tenancy mức dòng (row-level).** Mọi bảng domain đều mang `site_id`;
   query được scope ở tầng ORM và được cưỡng chế lần nữa bởi RLS middleware
   (`apps/cms/src/middleware/rls.ts`).
2. **Resolve tenant theo request** (`apps/cms/src/middleware/tenant.ts`),
   theo thứ tự ưu tiên:
   1. header `X-Lumi-Site` (Studio, SDK, server-to-server),
   2. map chính xác `Host` → site từ `site_domains` (custom domain, cache
      trong KV/Redis),
   3. map subdomain theo label đầu (legacy),
   4. query `?site=` (chỉ dev, `LUMIBASE_DEV_AUTH=true`).
   Hệ quả: **một instance phục vụ số lượng domain tenant tùy ý** — thêm domain
   là một thay đổi dữ liệu cộng DNS/TLS ở ingress, không phải một lần deploy.
3. **Config-as-Code API** (`apps/cms/src/routes/config.ts`):
   - `GET  /api/v1/config/export?scope=all|schema|settings|webhooks`
   - `POST /api/v1/config/import?dryRun=true` — validate + diff, không ghi
   - `POST /api/v1/config/import?mode=merge|replace-managed|replace-all&allowDestructive=…`
   Chỉ site-admin; mọi lần apply đều ghi audit log. Đây là phương tiện vận
   chuyển của Adaptive layer.
4. **Dual runtime.** Cùng một codebase CMS chạy trên Cloudflare Workers
   (`apps/cms/src/index.ts`) và dưới dạng container Node.js
   (`apps/cms/src/serve.ts`); business logic dùng runtime abstraction
   (`packages/runtime/`), nên một tenant có thể chuyển giữa hai runtime mà
   không đổi code.
5. **Pin version.** Deployment Docker pin Core image bằng `LUMIBASE_VERSION`
   (xem [Docker deployment](./docker.md)); Workers pin theo version Worker đã
   deploy. Đây là thứ cho phép lệch version theo tenant và rollout theo wave.
6. **Bề mặt offboarding.** Endpoint data export (`routes/data-export.ts`) và
   erasure (`routes/admin-erasure.ts`) hoạt động theo site, nên tenant rời đi
   không cần SQL thủ công.

## 3. Danh mục topology

### T1 — Pooled (cell dùng chung) · *mặc định*

**[Platform + Pattern]** Một cell phục vụ tất cả tenant. Isolation là logic
(`site_id` + RLS). Đây là topology mà các file compose của repository
(`docker/docker-compose.yml` + `docker-compose.prod.yml`) tạo ra sẵn.

```
┌─ cell: shared ────────────────────────────────┐
│ ingress (Caddy / proxy của bạn)               │
│   → cms (image :X.Y.Z, N replicas)            │
│   → postgres · redis · minio                  │
└───────────────────────────────────────────────┘
tenant-a.com ─┐
tenant-b.vn  ─┼─→ cùng ingress → resolve site theo Host
cms.acme.io  ─┘
```

- **Onboard tenant:** tạo site → đăng ký domain → apply config manifest →
  trỏ DNS. Không cần deployment mới.
- **Chọn khi:** đa số tenant, không có yêu cầu isolation/residency cứng, bạn
  muốn chi phí và tải vận hành thấp nhất.
- **Lưu ý:** noisy neighbor (giảm thiểu bằng pressure limiter và rate limit —
  xem [Docker deployment](./docker.md)), blast radius khi upgrade Core lỗi
  (giảm thiểu bằng rollout theo wave, §8.1).

### T2 — Hybrid (pool + cell riêng)

**[Pattern]** Cell pooled phục vụ phần đuôi dài; một số ít tenant có cell
riêng (CMS + Postgres riêng) vì hợp đồng, tải hoặc compliance. Cùng một Core
image ở mọi nơi, có thể pin version khác nhau.

```
cell shared   : tenant a…m         (LUMIBASE_VERSION=2.14.1)
cell tenant-n : chỉ tenant n       (2.14.1, DB riêng)
cell tenant-p : chỉ tenant p       (2.13.9 — giữ lại theo hợp đồng)
```

- **Chọn khi:** 80–95% tenant vừa với pool nhưng vài tenant cần tài nguyên
  riêng, version giữ lại, hoặc isolation theo hợp đồng.
- **Lưu ý:** kỷ luật về lệch version — ghi version pin của từng cell trong
  fleet repo và giới hạn độ lệch cho phép (vd. tối đa chậm một minor).

### T3 — Siloed (mỗi tenant một cell)

**[Pattern]** Mỗi tenant có một cell đầy đủ. Isolation mạnh nhất trên hạ tầng
của chính bạn; chi phí và tải vận hành cao nhất. Quản lý fleet theo kiểu khai
báo (một `tenant.yaml` cho mỗi tenant: domain, node/label đích, version Core
pin, resources) và deploy bằng `docker stack deploy` / Dokploy API / GitOps
agent — không bao giờ bằng tay.

- **Chọn khi:** ít tenant nhưng lớn; SLA theo tenant; dữ liệu chịu quản chế
  không được chung database.
- **Lưu ý:** fan-out khi upgrade (tự động hóa wave, §8.1) và drift cấu hình
  (§8.3). Không có vòng reconcile thì topology này xuống cấp nhanh nhất.

### T4 — Edge pooled (Cloudflare Workers)

**[Platform + Pattern]** Topology pooled trên runtime Workers: một Worker
(Core) + Postgres qua Hyperdrive + KV config cache + R2 media + Durable
Objects cho realtime, như mô tả trong [Deployment overview](./overview.md) và
[Cloudflare deployment](./cloudflare.md). Custom domain của tenant gắn qua
Cloudflare routes; resolve bằng cùng cơ chế Host-mapping như T1.

- **Chọn khi:** delivery đọc nhiều toàn cầu, tối thiểu vận hành hạ tầng,
  tenant trải rộng nhiều region.
- **Lưu ý:** scope Worker route vào đúng đường dẫn API (`/api/*`) để wildcard
  domain của tenant không che các property khác trên cùng zone; search ngoài
  (MeiliSearch) và các phụ thuộc self-host khác vẫn thuộc trách nhiệm của bạn.

### T5 — Regional cells (data residency)

**[Pattern]** Nhiều cell pooled, mỗi cell một region/khu vực pháp lý (vd.
`eu`, `vn`, `us`). Mỗi tenant được **pin vào đúng một cell**; cell được chọn
lúc onboard và ghi vào tenant registry. Lựa chọn routing, từ đơn giản nhất:

1. **Mức DNS:** domain của từng tenant trỏ thẳng vào ingress của cell —
   không cần router toàn cục. Khuyến nghị mặc định.
2. **Global edge router:** một proxy mỏng (vd. một Worker) map Host → origin
   của cell. Thêm một hop; chỉ đáng khi domain phải quản lý tập trung.

- **Chọn khi:** yêu cầu GDPR/địa phương hóa dữ liệu, hoặc tenant nhạy cảm về
  latency tập trung theo từng region.
- **Lưu ý:** không bao giờ để traffic xuyên cell chạm dữ liệu tenant (kể cả
  backup, pipeline observability); giữ storage backup theo từng region.

### T6 — Customer-hosted / BYOC

**[Pattern]** Cho khách hàng enterprise phải chạy trên hạ tầng của chính họ:
giao cho họ Core image đã pin cộng bundle compose (`docker-compose.yml` +
prod override + template `.env`) và Adaptive config manifest của họ. Khách
hàng vận hành cell; bạn giao upgrade dưới dạng image version pin mới kèm ghi
chú migration, và thay đổi config dưới dạng file manifest họ tự apply qua
Config API (`dryRun` trước).

- **Chọn khi:** procurement/security yêu cầu hạ tầng do khách kiểm soát hoặc
  vận hành air-gapped hoàn toàn.
- **Lưu ý:** gánh nặng support — định nghĩa cửa sổ version được hỗ trợ và
  nhịp upgrade trong hợp đồng; yêu cầu họ gửi kèm output
  `GET /api/v1/config/export` trong ticket support để bạn tái hiện được trạng
  thái Adaptive của họ.

### T7 — Environment lanes (dev → staging → prod)

**[Pattern]** Trực giao với T1–T6: mỗi environment là một cell (hoặc pool)
riêng, và Adaptive manifest của tenant được **promote** qua từng lane thay vì
sửa tại chỗ. Manifest trong git là artifact; promotion = apply cùng một
manifest lên lane kế tiếp sau khi review `dryRun`. Mẹo shared-domain cho môi
trường non-production xem
[Shared-domain environments](./shared-domain-environments.md).

## 4. Chọn topology

| Tiêu chí | T1 Pooled | T2 Hybrid | T3 Siloed | T4 Edge | T5 Regional | T6 BYOC |
| --- | --- | --- | --- | --- | --- | --- |
| Chi phí hạ tầng / tenant | thấp nhất | thấp | cao | thấp nhất | thấp–vừa | của khách |
| Tải vận hành | thấp nhất | vừa | cao | thấp | vừa | theo hợp đồng |
| Isolation | logic (RLS) | hỗn hợp | vật lý | logic | logic + geo | vật lý |
| Blast radius khi upgrade lỗi | mọi tenant | chỉ pool | một tenant | mọi tenant | một region | một khách |
| Pin version theo tenant | không | chỉ cell riêng | có | không | theo cell | có |
| Data residency | không | một phần | có | region Cloudflare | có | có |
| Tốc độ onboard | phút | phút (pool) | thời gian dựng cell | phút | phút | ngày–tuần |

Khuyến nghị mặc định: **bắt đầu ở T1, tiến hóa lên T2 khi tenant đầu tiên đòi
isolation, và coi T3/T5/T6 là quyết định có chủ đích, có định giá.** Mọi
topology dùng chung một Core artifact và một định dạng Adaptive manifest, nên
lựa chọn có thể đảo ngược (§7).

## 5. Adaptive layer dưới dạng Config-as-Code

**[Platform + Pattern]** Giữ một repository khai báo duy nhất cho fleet:

```
fleet/
├── templates/                     # Core: compose templates, shared services
├── tenants/
│   └── acme/
│       ├── tenant.yaml            # cell, domains, version pin, resources
│       └── lumibase.config.json   # Adaptive manifest (output của config/export)
└── waves.yaml                     # nhóm tenant canary → wave-1 → wave-2
```

Vòng thay đổi cho Adaptive layer:

```bash
# 1. Plan — validate + diff với site đang chạy (không ghi)
curl -s -X POST "$CMS/api/v1/config/import?dryRun=true" \
  -H "X-Lumi-Site: $SITE_ID" -H "Authorization: Bearer $TOKEN" \
  -d @tenants/acme/lumibase.config.json

# 2. Apply — sau khi diff đã được review
curl -s -X POST "$CMS/api/v1/config/import?mode=merge" \
  -H "X-Lumi-Site: $SITE_ID" -H "Authorization: Bearer $TOKEN" \
  -d @tenants/acme/lumibase.config.json
```

Các quy tắc giữ an toàn:

- `allowDestructive=true` luôn **tắt** trong CI; thay đổi schema phá hủy được
  apply thủ công với diff đã review.
- Manifest trong git là source of truth; chỉnh sửa qua Studio trên site
  production hoặc bị cấm theo policy, hoặc phải re-export vào git ngay.
- Secret không bao giờ nằm trong `tenant.yaml` hay manifest — dùng secret
  store của bạn (Docker secrets, file mã hóa sops, Wrangler secrets).

## 6. Vòng đời tenant

**[Pattern, ghép từ các API Platform]**

1. **Onboard:** tạo site → đăng ký domain (`routes/domains.ts`) → apply
   Adaptive manifest (`dryRun` → apply) → cấp DNS/TLS ở ingress → smoke-check
   `/health` và một lần đọc có xác thực.
2. **Thay đổi:** sửa manifest trong git → PR đính kèm diff `dryRun` → apply
   khi merge (theo từng environment lane, §T7).
3. **Scale/di chuyển:** xem các lộ trình migration, §7.
4. **Offboard:** đóng băng ghi → `data-export` để bàn giao → endpoint erasure
   cho PII → gỡ domain và site → archive thư mục tenant trong git (giữ để
   audit; thư mục là lịch sử, không phải config đang sống).

## 7. Lộ trình migration giữa các topology

**[Pattern]** Mọi lộ trình đều dựa trên đúng hai artifact — Adaptive manifest
và bản export dữ liệu của tenant — cộng công cụ PostgreSQL tiêu chuẩn:

- **T1 → T2/T3 (pool → riêng):** dựng cell mới ở cùng version Core → apply
  manifest của tenant → copy các dòng của tenant (dump/restore scope theo
  site) → verify số lượng và spot-check nội dung → chuyển DNS (hạ TTL trước)
  → gỡ tenant khỏi cell pool.
- **T3 → T1 (riêng → pool):** ngược lại quy trình trên; kiểm tra trước rằng
  version Core của cell pool ≥ version pin của tenant.
- **Docker ↔ Workers (T1 ↔ T4):** codebase Core portable giữa hai runtime;
  phần việc nằm ở các stateful service (Postgres ↔ Postgres qua Hyperdrive,
  MinIO ↔ R2, Redis ↔ KV). Lập kế hoạch như một cuộc migration dữ liệu, không
  phải migration code.

Luôn diễn tập trên lane staging với bản copy dữ liệu của tenant trước cửa sổ
production.

## 8. Vận hành fleet

### 8.1 Upgrade theo wave

**[Pattern]** Không bao giờ upgrade cả fleet cùng lúc. Duy trì các nhóm wave
(`canary` → `wave-1` → `wave-2`) trong fleet repo; bump `LUMIBASE_VERSION`
theo từng wave với thời gian soak giữa các wave. Với T1/T4 (một Core dùng
chung), đơn vị wave là *environment lane*: dev → staging → prod.

### 8.2 Observability

**[Pattern]** Một mặt phẳng observability dùng chung cho mọi cell (repo có
sẵn file compose Prometheus/Grafana trong `docker/`). Gắn nhãn mọi
metric/log stream với `cell` và, chỗ nào CMS phát ra, `site_id`, để dashboard
và alert theo tenant hoạt động ở mọi topology. Alert tối thiểu cho: `/health`
theo cell, error rate theo site, áp lực event-loop (tỉ lệ
`SERVICE_UNAVAILABLE`), và độ trễ queue/CDC.

### 8.3 Phát hiện drift

**[Pattern]** Reconcile theo lịch (vd. mỗi giờ): với từng tenant, chạy
`dryRun` của Config API so với manifest trong git và diff định nghĩa stack
đang chạy so với template đã render. Diff khác rỗng = drift → alert, và hoặc
re-apply (autofix) hoặc mở ticket, tùy policy của bạn.

### 8.4 Backup & restore

**[Pattern]** Phạm vi backup đi theo topology: backup Postgres theo cell
(T1/T4: một backup phủ mọi tenant; T3/T5: theo tenant/region) cộng replication
object storage. Diễn tập restore là một phần của release checklist — xem
`docker/restore-drill.env.example` cho input của bộ diễn tập. Với cell pooled,
hãy luyện **restore một tenant đơn lẻ** (trích xuất scope theo site từ full
backup), vì đó mới là yêu cầu bạn sẽ thật sự nhận được.

## 9. Cân nhắc bảo mật

- Isolation logic trong các topology pooled đặt trên `site_id` scoping + RLS —
  giữ RLS middleware trong mọi profile deployment và coi bất kỳ query thiếu
  site scope nào là release blocker (Strict Rule #2). **[Platform]**
- Terminate TLS theo từng domain tenant tại ingress; tự động hóa cấp
  certificate (Caddy làm sẵn việc này trong các file compose đi kèm). **[Platform]**
- API key và rate limit theo tenant giảm rủi ro noisy-neighbor xuyên tenant và
  blast radius khi lộ credential trong cell pooled. **[Platform]**
- Ở T5/T6, kiểm chứng rằng các luồng dữ liệu *vận hành* (backup, log, metric,
  error tracker) cũng tôn trọng residency, không chỉ database chính. **[Pattern]**

## 10. Tài liệu liên quan

- [Deployment overview](./overview.md)
- [Docker deployment](./docker.md)
- [Cloudflare deployment](./cloudflare.md)
- [Shared-domain environments](./shared-domain-environments.md)
- [Environment variables](./environment-variables.md)
- [Data model](../data-model.md) · [User management & auth realms](../security/user-management.md)
