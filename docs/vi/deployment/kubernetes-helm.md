---
sourceLang: en
version: 4
lastUpdated: 2026-11-15T11:58:12.013Z
translatedFrom: en
sourceHash: 4746964dae05d4e2
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T11:58:12.013Z
codeVerifiedHash: 4746964dae05d4e2
codeVerifiedClaims: 36
---

# Kubernetes (Helm chart)

Chart chính thức trong `deploy/helm/lumibase/` chạy image đã publish
`ghcr.io/khuepm/lumibase-cms` trên Kubernetes: CMS API **và** Studio từ một
Deployment trên cùng một origin, migration chạy trước khi server khởi động,
probe trỏ vào chính các route health của server, và mức hardening mà image được
build cho nó (non-root UID 65532, root filesystem read-only, không capability).
PostgreSQL và Redis được kèm sẵn cho lần cài đầu tiên và thay bằng dịch vụ
managed khi lên production; Meilisearch là tuỳ chọn.

| Resource | Khi nào |
|----------|---------|
| Deployment `<release>-lumibase` (API + Studio, role `all` hoặc `web`) | luôn luôn |
| Service, ConfigMap, Secret, ServiceAccount | luôn luôn |
| StatefulSet + Service cho PostgreSQL / Redis | `postgresql.enabled` / `redis.enabled` (mặc định bật) |
| StatefulSet + Service cho Meilisearch | `meilisearch.enabled` |
| Deployment `<release>-lumibase-worker` (role `worker`) | `worker.enabled` |
| Job `<release>-lumibase-migrate-<hash>` | `migrations.mode=job` |
| Ingress (TLS tuỳ chọn) | `ingress.enabled` |
| HorizontalPodAutoscaler, PodDisruptionBudget, NetworkPolicy | `autoscaling.enabled`, `podDisruptionBudget.enabled`, `networkPolicy.enabled` |
| Pod `helm test` | `tests.enabled` (mặc định bật) |

Yêu cầu: Kubernetes 1.25 trở lên, Helm 3.8 trở lên (OCI registry), và một
StorageClass mặc định khi các dịch vụ kèm sẵn giữ persistence bật. Chart gọi
trực tiếp entrypoint distroless và migration runner của image, nên cần image đã
hardening ở [Image đã hardening](./docker.md#image-đã-hardening) — bản release
mà chart được publish cùng, hoặc `image.tag=edge` cho `main`.

## Cài đặt

Chart được publish dưới dạng OCI artifact cùng mỗi release, đánh version theo
release, và image tag mặc định của nó chính là release đó:

```bash
helm install lumibase oci://ghcr.io/khuepm/charts/lumibase --version <version> \
  --namespace lumibase --create-namespace \
  --set publicUrl=https://cms.example.com
```

Từ một bản checkout, dùng đường dẫn thay thế: `helm install lumibase ./deploy/helm/lumibase …`.

`publicUrl` là giá trị duy nhất bạn bắt buộc phải đặt. Ở production server từ
chối khởi động khi thiếu `CORS_ALLOWED_ORIGINS`, và chart dừng việc render kèm
thông báo thay vì để pod rơi vào crash loop. Chart chấp nhận một trong các cách:
`publicUrl`, `corsAllowedOrigins`, hoặc `ingress.enabled` kèm host (khi đó origin
là `https://<host>` nếu có mục TLS liệt kê host đó, ngược lại là `http://<host>`).

### Thử trên máy (kind, port-forward)

```bash
kind create cluster
helm install lumibase ./deploy/helm/lumibase -n lumibase --create-namespace \
  --set publicUrl=http://localhost:1989 --wait --timeout 10m
kubectl -n lumibase port-forward service/lumibase 1989:80
```

Rồi mở `http://localhost:1989/setup`. Ghi chú sau khi cài in ra các bước tiếp
theo, gồm cả lệnh lấy setup token bên dưới.

## Setup token

Chart đặt `LUMIBASE_REQUIRE_SETUP_TOKEN=true` (`setup.requireToken`): instance
truy cập được trước khi có ai setup nó, và nếu không có token thì ai vào `/setup`
trước sẽ chiếm instance. Web pod khởi động đầu tiên sinh token và in nó một lần:

```bash
kubectl -n lumibase logs -l app.kubernetes.io/instance=lumibase,app.kubernetes.io/component=cms \
  --tail=-1 --prefix | grep SETUP_TOKEN=
```

Plaintext không được lưu, nên restart pod sẽ không in lại. Nếu mất token trước
khi setup xong, hãy xoá hash đã lưu rồi restart; lần khởi động sau in token mới
(câu lệnh là `CLEAR_SETUP_TOKEN_SQL` trong `apps/cms/src/modules/setup/startup.ts`):

```bash
kubectl -n lumibase exec statefulset/lumibase-postgresql -- \
  psql -U lumibase -d lumibase -c "UPDATE lumibase_system_state SET setup_token_hash = NULL WHERE id = 'singleton';"
kubectl -n lumibase rollout restart deployment/lumibase
```

## Secret

Secret do chart quản lý `<release>-lumibase` chứa `JWT_SECRET`, `ENCRYPTION_KEY`
và mật khẩu của các dịch vụ kèm sẵn. Với mỗi giá trị, thứ tự là: giá trị bạn
đặt, nếu không thì giá trị đã có trong Secret (đọc bằng `lookup` của Helm, nên
`helm upgrade` giữ nguyên nó), nếu không nữa thì sinh mới. Giá trị sinh ra không
bao giờ được ghi ngược vào values của bạn, nên không có gì bí mật lọt vào file
bạn commit.

- `ENCRYPTION_KEY` được sinh dưới dạng base64 chuẩn của 32 byte ngẫu nhiên,
  đúng dạng server chấp nhận. Key bạn tự đặt được kiểm tra ngay khi render theo
  cùng quy tắc (16, 24 hoặc 32 byte, padding chuẩn) — ở production server sẽ từ
  chối mọi dạng khác.
- Secret mang annotation `helm.sh/resource-policy: keep`
  (`secrets.keepOnUninstall`): `helm uninstall` giữ nó lại, và cài lại với cùng
  tên release và namespace sẽ dùng lại nó thay vì sinh một key không đọc được dữ
  liệu cũ.
- **Sao lưu `ENCRYPTION_KEY`** ngay sau lần cài đầu tiên (ghi chú cài đặt in
  sẵn lệnh). Các trường mã hoá và seed two-factor không đọc được nếu thiếu nó;
  xem [Khoá mã hoá](../operations/encryption-keys.md).
- URL của dịch vụ kèm sẵn không bao giờ được lưu: pod spec chứa
  `postgresql://lumibase:$(LUMIBASE_HELM_POSTGRES_PASSWORD)@…`, và Kubernetes
  điền mật khẩu từ Secret khi container khởi động.

**GitOps (Argo CD, Flux) và `helm template`:** `lookup` không trả về gì khi chart
được render mà không kết nối cluster, nên giá trị sinh ra sẽ đổi sau mỗi lần
sync — mỗi lần một `ENCRYPTION_KEY` mới. Hãy tự tạo Secret và trỏ chart vào nó:

```bash
kubectl -n lumibase create secret generic lumibase-app \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

```yaml
secrets:
  existingSecret: lumibase-app   # key JWT_SECRET và ENCRYPTION_KEY
```

Điều tương tự áp dụng cho mật khẩu của dịch vụ kèm sẵn
(`postgresql.auth.existingSecret`, `redis.auth.existingSecret`), hoặc chạy
PostgreSQL và Redis bên ngoài chart.

## Values cho production

```yaml
publicUrl: https://cms.example.com
secrets:
  existingSecret: lumibase-app
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: cms.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - secretName: cms-example-com-tls
      hosts: [cms.example.com]
postgresql:
  enabled: false
database:
  external:
    existingSecret: lumibase-db        # key DATABASE_URL, kèm sslmode=require
redis:
  enabled: false
  external:
    existingSecret: lumibase-redis     # key REDIS_URL
meilisearch:
  external:
    host: https://search.example.com
    existingSecret: lumibase-search    # key MEILISEARCH_API_KEY
s3:
  endpoint: https://s3.eu-central-1.amazonaws.com
  bucket: lumibase-media
  existingSecret: lumibase-s3          # key S3_ACCESS_KEY, S3_SECRET_KEY
podDisruptionBudget:
  enabled: true
networkPolicy:
  enabled: true
  ingressFrom:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
```

## Values và biến môi trường tương ứng

Mỗi thiết lập ánh xạ tới một biến mà image đọc; xem
[Biến môi trường](./environment-variables.md) để biết tác dụng của từng biến.
Những biến khác đặt trong `config` (không bí mật, render vào ConfigMap, và thắng
các key của chính chart), `extraEnv` hoặc `extraEnvFrom`.

| Value | Biến |
|-------|------|
| `environment` | `NODE_ENV` (khi là `production`), `LUMIBASE_ENV` |
| `publicUrl` (hoặc host của ingress) | `LUMIBASE_PUBLIC_URL` |
| `corsAllowedOrigins` (mặc định: origin công khai) | `CORS_ALLOWED_ORIGINS` |
| `setup.requireToken` | `LUMIBASE_REQUIRE_SETUP_TOKEN` |
| `studio.enabled` | `LUMIBASE_SERVE_STUDIO` |
| `secrets.*` | `JWT_SECRET`, `ENCRYPTION_KEY` |
| `postgresql.*` / `database.external.*` | `DATABASE_URL` |
| `database.sslMode` (`disable` với PostgreSQL kèm sẵn) | `DATABASE_SSL_MODE` |
| `database.rls`, `database.systemUrl.*` | `LUMIBASE_DB_RLS`, `DATABASE_SYSTEM_URL` |
| `redis.*` | `REDIS_URL` |
| `meilisearch.*` | `MEILISEARCH_HOST`, `MEILISEARCH_API_KEY` |
| `s3.*` | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |
| `cms.role`, `worker.enabled` | `LUMIBASE_PROCESS_ROLE` |
| `worker.healthPort` | `LUMIBASE_WORKER_HEALTH_PORT` |
| `migrations.mode` | `SKIP_MIGRATIONS`, `MIGRATION_MODE` (init container) |
| `migrations.target` | `MIGRATE_TARGET` (các runner migration và gate) |

Chart luôn đặt `LUMIBASE_RUNTIME=docker` và `PORT=1989`.
`values.schema.json` từ chối values sai dạng trước khi bất cứ thứ gì được render.

## Migration

Hai thành phần của runner migration trong image (`dist/migrate.cjs`) sắp thứ
tự cho mọi mode:

- **Lock.** `migrate.cjs apply` giữ một advisory lock PostgreSQL cấp session
  trong suốt quá trình apply. Key cố định: `5509430018010346341`, chính là các
  byte ASCII của `LumiBase` (`pg_locks` hiển thị là `classid = 1282764137`,
  `objid = 1113682789`). Các runner khởi động cùng lúc (nhiều web replica, pod
  surge, HPA scale-out, entrypoint trên hai replica) xếp hàng trên lock này:
  runner đầu tiên apply, mỗi runner sau đó không còn gì pending, ghi log
  `Nothing to apply` và thoát với mã 0. Postgres nhả lock khi kết nối của
  runner đóng, nên pod bị kill không bao giờ bỏ lại lock. Một runner chờ tối đa
  `MIGRATION_LOCK_TIMEOUT` giây (mặc định 900) rồi báo lỗi, và Kubernetes chạy
  lại nó.
- **Gate.** `migrate.cjs wait --timeout <seconds>` chỉ đọc: thoát với mã 0 khi
  database không còn migration nào pending so với journal đóng gói trong
  image, poll với backoff (1 giây, nhân đôi đến 10 giây), và thoát với mã 1 khi
  hết thời gian (`migrations.waitTimeoutSeconds`, mặc định 600), sau đó
  Kubernetes khởi động lại init container.

`migrations.mode` chọn ai apply migration:

- `initContainer` (mặc định): mỗi web pod trước tiên chạy entrypoint của image
  với `MIGRATION_MODE=preflight` — chờ database bằng chính cơ chế retry và
  backoff của entrypoint và in ra phiên bản schema — rồi chạy
  `node /app/dist/migrate.cjs apply` dưới lock. Container server khởi động với
  `SKIP_MIGRATIONS=true`. Migration lỗi sẽ giữ pod ngoài vòng phục vụ thay vì
  phục vụ trên schema mới migrate một nửa, và rolling update dừng tại đó.
- `job`: một Job, `<release>-lumibase-migrate-<hash>`, chạy cùng preflight và
  `apply`; web pod chỉ chạy gate. Hash lấy từ pod spec của Job, thứ mà
  Kubernetes không cho sửa: image hoặc thiết lập database mới tạo ra Job mới
  (Helm xoá Job trước đó), còn áp lại values không đổi — `helm upgrade`, hay
  một lần Argo CD sync output của `helm template` — để nguyên Job đã chạy xong.
  Với `networkPolicy.enabled`, các dịch vụ kèm sẵn cũng nhận pod của Job.
- `entrypoint`: web pod không có init container; image tự migrate mỗi lần khởi
  động dưới cùng lock đó, giống trên Docker và các nền tảng one-click.
- `none`: `SKIP_MIGRATIONS=true` ở mọi nơi và không có gate; bạn tự chạy
  migration từ pipeline của mình trước khi rollout.

Worker pod không bao giờ migrate. Ở mọi mode trừ `none`, worker Deployment
khởi động với init container `migrations-ready` chạy gate, cùng image và cùng
hardening với migrator của web, nên queue consumer và scheduler không khởi
động trên schema cũ hơn schema mà image của chúng được build cho, dù là lần
cài mới hay khi nâng cấp.

Cố ý không dùng Helm hook: hook pre-install hay pre-upgrade chạy trước khi
PostgreSQL kèm sẵn và Secret của chart tồn tại, nên ở lần cài đầu tiên không
thể kết nối database; hook post-install dưới `helm install --wait` sẽ chờ các
web pod mà chính chúng đang chờ migration. Hook cũng không phải resource của
release, nên rollback không theo dõi chúng.

`migrations.target` (nâng cao) dừng lịch sử migration tại một tag, ví dụ
`0029_activation_milestones`, cho cả runner lẫn gate. Nó dành cho nâng cấp theo
từng bước và cho test nâng cấp trong CI; hãy để trống.

### Nâng cấp khi có nhiều replica

Khi `helm upgrade` lên một image có migration mới, ở mode `initContainer`:

1. Các web pod mới khởi động (nhiều nhất cùng lúc theo `cms.strategy` cho phép;
   HPA có thể thêm nữa). Mỗi pod chạy migrator của nó; lock chỉ cho đúng một
   pod apply, các pod khác chờ pod đó rồi không còn gì để apply.
2. Gate của worker pod mới thấy migration đang pending và chờ; container worker
   chỉ khởi động sau khi lần apply đã commit.
3. Web pod và worker pod cũ tiếp tục phục vụ đến khi pod thay thế Ready, nên
   trong suốt quá trình rollout code cũ chạy trên schema mới. Giữ migration
   tương thích ngược với release trước (expand, rồi contract ở release sau),
   như các migration đóng gói sẵn.

Migration lỗi sẽ rollback transaction của nó, nhả lock và giữ các pod mới ở
`Init`: rollout dừng lại, và pod cũ tiếp tục phục vụ.

Đọc [Nâng cấp](../operations/upgrades.md) trước khi đổi `image.tag` qua một bản
major.

## Health check

| Probe | Path | Lý do |
|-------|------|-------|
| startup, liveness | `/health` | Trả 200 bất cứ khi nào process phục vụ HTTP, nên sự cố database không làm restart mọi pod. |
| readiness | `/health/ready` hoặc `/health` | `/health/ready` trả 503 khi bất kỳ database, cache, search, storage hay queue nào không khoẻ. |

`cms.readinessPath` để trống (mặc định) chỉ chọn `/health/ready` khi search
**và** object storage đều được cấu hình; ngược lại dùng `/health`, vì
`/health/ready` sẽ báo dịch vụ còn thiếu và không bao giờ ready. Đặt tường minh
để ghi đè. Worker pod probe `/health` và `/health/ready` trên `worker.healthPort`.

## Mở rộng

- `cms.replicaCount` hoặc `autoscaling.enabled` (CPU, tuỳ chọn thêm memory) mở
  rộng web Deployment. Scheduled job được khoá leader qua Redis, nên nhiều
  replica không chạy chúng hai lần.
- `worker.enabled` chuyển queue worker và scheduler sang Deployment riêng
  (`LUMIBASE_PROCESS_ROLE=worker`), và web pod chuyển sang `web`.
- **Giới hạn realtime:** trên Docker runtime, sự kiện WebSocket được phát trong
  process (`packages/runtime/src/adapters/docker/realtime.ts`), nên với nhiều hơn
  một web replica, client chỉ nhận sự kiện được publish bởi pod nó đang kết nối.
  Giữ một web replica nếu bạn phụ thuộc vào realtime, hoặc chấp nhận giới hạn đó.
- `podDisruptionBudget.enabled` bảo vệ web pod khi drain node.

## Dịch vụ kèm sẵn

PostgreSQL (`postgres:16-alpine`), Redis (`redis:7-alpine`) và Meilisearch
(`getmeili/meilisearch:v1.7`, đúng các phiên bản trong `docker/docker-compose.yml`)
là các StatefulSet một instance đơn giản, non-root với root filesystem
read-only. Chúng không phải dependency subchart: subchart phải được tải từ chart
repository lúc cài và tự quyết lịch release cùng image của nó, còn template
trong chart này cài được offline và được review cùng chart. Chúng không có
replication và không có backup; dùng để đánh giá, còn production thì dùng dịch
vụ managed. Redis chạy với AOF persistence và `noeviction`, vì job BullMQ không
bao giờ được phép bị evict.

Object storage không được kèm sẵn. Không có `s3.endpoint`, instance vẫn khởi động
và setup vẫn hoàn tất, nhưng upload không hoạt động.

## NetworkPolicy

Với `networkPolicy.enabled`, web pod chỉ nhận traffic trên cổng HTTP (từ
`networkPolicy.ingressFrom` nếu có đặt), worker không nhận gì (traffic từ chính
node của pod, nơi kubelet gửi probe, luôn được phép), còn PostgreSQL, Redis và Meilisearch kèm sẵn
chỉ nhận web pod và worker pod của release (và pod của Job migration khi
`migrations.mode=job`). Egress không bị giới hạn: CMS gọi
object storage, nhà cung cấp LLM và webhook.

## Kiểm tra

```bash
helm test lumibase -n lumibase --logs
```

Pod test dùng chính Node của image release để kiểm tra, qua Service, rằng
`/health` trả lời, `/api/v1/setup/state` trả lời, và `/setup` phục vụ khung
Studio. Trong CI, `.github/workflows/helm.yml` lint chart, chạy
`scripts/__tests__/helm-chart.test.mjs` (test render), và
`scripts/helm-kind-smoke.sh` cài chart lên kind với image build từ cùng commit,
chạy `helm test`, upgrade, rồi kiểm tra `ENCRYPTION_KEY` không đổi. Sau đó nó
cài một worker và hai web replica thiếu một migration so với journal của image
rồi nâng cấp lên toàn bộ journal, kiểm tra rằng bảng migration chứa mỗi
migration đúng một lần, đúng một web pod đã apply nó, và worker chỉ khởi động
sau khi gate của nó qua; cuối cùng chuyển release sang `migrations.mode=job`.

## Nâng cấp và gỡ cài đặt

```bash
helm upgrade lumibase oci://ghcr.io/khuepm/charts/lumibase --version <new> -n lumibase -f my-values.yaml
helm uninstall lumibase -n lumibase
```

`helm uninstall` giữ lại Secret (xem [Secret](#secret)) và PersistentVolumeClaim
của các StatefulSet; tự xoá chúng khi muốn bỏ dữ liệu.
