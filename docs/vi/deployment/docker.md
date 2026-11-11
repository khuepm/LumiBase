---
<!-- check-parity: allow inline-code -->
version: 3
lastUpdated: 2026-11-11T02:50:37.617Z
sourceLang: en
translatedFrom: en
sourceHash: 0f27a65a095fdab4
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-11T03:00:27.283Z
codeVerifiedHash: 0f27a65a095fdab4
codeVerifiedClaims: 18
---

<!-- check-parity: allow code-fences headings -->
<!-- Recorded by stamp-pair --allow-structure-drift on 2026-10-10T05:00:15.277Z. See commit history for rationale. -->

<!-- check-parity: allow inline-code -->

# Docker Deployment

Docker mode chạy CMS API bằng Node.js và dùng hạ tầng tự host cho các dịch vụ stateful.

## Dịch vụ

File compose nền là `docker/docker-compose.yml`. Khi chạy production/self-hosted,
thêm override `docker/docker-compose.prod.yml`. Override production dùng cho:

- CMS API container từ image CMS đã publish.
- PostgreSQL.
- Redis cho cache và queue adapter.
- MinIO cho object storage tương thích S3.
- Prometheus/Grafana nếu bật observability.

## Cấu hình

Tạo file môi trường từ mẫu:

```bash
cp docker/.env.example docker/.env
```

Cập nhật giá trị production cho database, Redis, object storage, JWT và admin authentication trước khi start stack.

> **Nếu bạn chỉ thử stack này ở local, hãy đặt `DATABASE_SSL_MODE=disable`.**
> Bản override production để default là `require`
> (`DATABASE_SSL_MODE: ${DATABASE_SSL_MODE:-require}` trong
> `docker/docker-compose.prod.yml`) — đúng cho một database managed, nhưng không
> kết nối được tới container PostgreSQL của compose gốc vì container đó không
> phục vụ TLS, nên CMS chết lúc khởi động bằng một lỗi kết nối thay vì một lỗi
> cấu hình. Với deployment thật thì giữ nguyên default `require`.

## Chạy production

Pin CMS image bằng `LUMIBASE_VERSION` để production chạy đúng release mong muốn.
Nếu không set, `docker/docker-compose.prod.yml` sẽ fallback về `latest`.

```bash
LUMIBASE_VERSION=0.4.3 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

Kiểm tra API:

```bash
curl -fsS http://localhost:1989/health
```

## Build local thay vì pull image đã publish

Giữ build local trong override riêng để production mặc định luôn dùng image đã
publish. Thêm `docker/docker-compose.build.yml` sau production override:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  -f docker/docker-compose.build.yml \
  up -d --build
```

## Image đã hardening

Image được publish (`docker/Dockerfile`) được build để chạy với mức tối thiểu
có thể:

| Thuộc tính | Ý nghĩa với bạn |
|------------|-----------------|
| Runtime distroless (`gcr.io/distroless/nodejs22-debian13:nonroot`) | Chỉ có Node.js và các thư viện runtime của nó — không shell, không package manager, không `curl`. `docker exec -it <container> sh` không chạy được; hãy dùng `docker debug` hoặc một container debug tạm thời. |
| Non-root | Chạy với UID/GID `65532`. File ứng dụng thuộc root và user đó không ghi được. |
| Root filesystem chỉ đọc | Server không ghi gì xuống đĩa, nên container chạy với `read_only: true`. `docker/docker-compose.prod.yml` và `docker/docker-compose.gcp.yml` bật nó, cùng với `cap_drop: [ALL]`, `no-new-privileges` và `init: true`. |
| Healthcheck | `HEALTHCHECK` chạy `docker/scripts/healthcheck.mjs` bằng chính Node của image. Nó probe `PORT`, hoặc cổng health của worker khi `LUMIBASE_PROCESS_ROLE=worker`. |
| Entrypoint | `docker/scripts/entrypoint.mjs` (Node) thay cho `entrypoint.sh`. `SKIP_MIGRATIONS`, `RUN_MIGRATION_PREFLIGHT`, `MIGRATION_MODE` và các secret `*_FILE` hoạt động như trước. |

### Server ghi dữ liệu ở đâu

Không có gì server cần nằm trên filesystem của container:

| Dữ liệu | Nơi lưu |
|---------|---------|
| Nội dung, user, audit log, trạng thái setup | PostgreSQL (`DATABASE_URL`) |
| Cache, rate limit, queue, leader lock | Redis (`REDIS_URL`) |
| Media upload | Storage tương thích S3 (`S3_ENDPOINT`) |
| Search index | Meilisearch (`MEILISEARCH_HOST`) |
| Log | stdout/stderr |
| `/tmp` | Một `tmpfs` 64 MiB trong các file compose production, chỉ dành cho code bên thứ ba gọi `os.tmpdir()`. Bản thân LumiBase không dùng nó; `/tmp` chỉ đọc vẫn khởi động được. |

Input chỉ đọc: `/app/dist`, `/app/drizzle`, `/app/studio`, các secret `*_FILE`,
các file `ENCRYPTION_KEY_<id>`, và database GeoIP tùy chọn tại
`/var/lib/lumibase/geoip/GeoLite2-Country.mmdb`.

Để chạy image đã publish theo cùng cách mà không dùng Compose:

```bash
docker run --read-only --tmpfs /tmp:size=64m --cap-drop ALL \
  --security-opt no-new-privileges:true --init \
  --env-file docker/.env -p 1989:1989 ghcr.io/khuepm/lumibase-cms:<version>
```

### Kiểm chứng image bạn pull

Mọi image release đều được scan trước khi push: release workflow fail khi có
bất kỳ phát hiện **CRITICAL** nào, trong image hoặc trong npm lockfile (server
là một bundle, nên các dependency npm chỉ nhìn thấy được qua lockfile). Các
ngoại lệ được chấp nhận nằm trong `.trivyignore`, mỗi mục kèm lý do. Sau đó
image được ký bằng cosign keyless và mang một attestation SBOM SPDX; cả hai SBOM
(`lumibase-cms-image.spdx.json`, `lumibase-dependencies.spdx.json`) được đính
kèm vào GitHub Release.

```bash
IMAGE=ghcr.io/khuepm/lumibase-cms:<version>
cosign verify "$IMAGE" \
  --certificate-identity-regexp '^https://github\.com/khuepm/LumiBase/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation "$IMAGE" --type spdxjson \
  --certificate-identity-regexp '^https://github\.com/khuepm/LumiBase/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Các build `edge` từ `main` không được ký bằng cosign; hãy pin một tag release trong production.

### Nâng cấp từ image từng chạy bằng root hoặc ghi vào filesystem của nó

- **File secret** mount cho `*_FILE` phải đọc được bởi UID `65532`
  (ví dụ mode `0444`, hoặc thuộc sở hữu của `65532`). Secret của Docker Compose
  mặc định đọc được.
- **Bind mount hoặc volume** bạn thêm dưới `/app` để làm chỗ ghi tạm không còn
  ghi được nữa. Không thành phần nào của LumiBase cần chúng; hãy gỡ bỏ, hoặc
  mount một `tmpfs`.
- **Entrypoint hoặc command tùy chỉnh** gọi `/entrypoint.sh`, `bash` hoặc `sh`
  sẽ fail: không có shell. Entrypoint của image là
  `["/nodejs/bin/node", "/app/bin/entrypoint.mjs"]`; để chạy một lệnh migration,
  override nó bằng `--entrypoint /nodejs/bin/node` và truyền
  `dist/migrate.cjs preflight` (hoặc `apply`).
- **Health probe của orchestrator** từng dùng `curl` bên trong container phải
  chuyển sang probe HTTP tới `/health` hoặc sang
  `/nodejs/bin/node /app/bin/healthcheck.mjs`.

## Note: lỗi `SERVICE_UNAVAILABLE` do instance under pressure

Nếu client nhận HTTP `503` với nội dung tương tự:

```json
{
  "errors": [
    {
      "code": "SERVICE_UNAVAILABLE",
      "message": "LumiBase API is temporarily unavailable because this instance is under pressure. Retry later.",
      "details": { "reason": "event_loop_delay" }
    }
  ]
}
```

điều này không nhất thiết nghĩa là service CMS đã chết. Trong Docker mode, `LUMIBASE_PRESSURE_LIMITER_ENABLED=true` cho phép CMS tự bảo vệ khi event loop Node.js bị nghẽn. Guard trả `503` kèm `Retry-After` để upstream/client retry có kiểm soát thay vì tiếp tục dồn request vào một process đang quá tải.

Các nguyên nhân thường gặp:

- API bị gọi dồn hoặc CPU/RAM container quá thấp.
- Endpoint export/thống kê xử lý dữ liệu lớn bằng JavaScript trên hot path.
- Query kéo quá nhiều bản ghi rồi mới lọc/format/`JSON.parse` trong ứng dụng.
- Cache hoặc queue backend chậm làm request tích tụ.
- Docker compose trỏ nhầm hostname nội bộ, ví dụ service trong container phải gọi PostgreSQL bằng tên service như `postgres`, không phải `localhost`.

Hướng kiểm tra nhanh:

```bash
docker stats
docker compose logs --since=10m cms
curl -i http://localhost:1989/health
curl -s http://localhost:1989/metrics | grep -E 'nodejs_eventloop|process_cpu|lumibase_http_request_duration'
```

Nếu cần nới ngưỡng tạm thời trong lúc điều tra, có thể đặt:

```env
LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY=1500
LUMIBASE_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION=false
LUMIBASE_PRESSURE_LIMITER_RETRY_AFTER=5
```

Chỉ tắt guard trong thời gian ngắn khi đã có cơ chế bảo vệ khác ở reverse proxy hoặc autoscaling:

```env
LUMIBASE_PRESSURE_LIMITER_ENABLED=false
```

Không nên tắt lâu dài. Cách xử lý đúng là xác định endpoint gây spike, tối ưu query/index/pagination/export streaming, hoặc tăng replica/CPU cho CMS.

## Kích thước request & rate limit

Reverse proxy Caddy giới hạn body của request trước khi tới CMS
(`docker/Caddyfile`): 10 MB cho API chung và 50 MB cho các route upload
media/asset (`/api/v1/media*`, `/api/v1/files*`). Giữ giới hạn media đồng bộ
với `FILE_UPLOAD_MAX_BYTES` nếu bạn đổi một trong hai. Chỉnh giới hạn chung theo
workload của bạn — phần lớn JSON API không bao giờ cần quá vài MB.

Như một lớp phòng thủ bổ sung cho các deployment không đặt Caddy trước CMS
(một process Node trần, hoặc một proxy khác), bản thân ứng dụng cũng từ chối
JSON body quá lớn:

```env
# Max JSON request body in bytes for the app-level guard (default 1 MiB).
# Returns 413 { errors: [{ code: "PAYLOAD_TOO_LARGE" }] } when exceeded.
LUMIBASE_MAX_JSON_BODY=1048576
```

## Các nút chỉnh caching & write-amplification

```env
# Delivery API shared-cache lifetime, seconds (default 60). 0 disables
# public caching (responses become private, no-store).
LUMIBASE_DELIVER_SMAXAGE=60
# Delivery API stale-while-revalidate window, seconds (default 300).
LUMIBASE_DELIVER_SWR=300
# Negative-cache (tombstone) TTL in seconds before ±20% jitter (default 30).
# 0 disables tombstones. See docs/en/features/caching.md.
LUMIBASE_NEGATIVE_CACHE_TTL=30
# Delivery API IP rate limit, requests per minute (default 1200). 0 = off.
LUMIBASE_DELIVER_RATE_LIMIT=1200
# Debounce window (seconds) for API-key lastUsedAt writes (default 60).
# Under read load, an API key's last-used timestamp is refreshed at most
# once per window instead of on every request. 0 = write on every request.
LUMIBASE_APIKEY_TOUCH_INTERVAL=60
```

## Rollback

Để rollback CMS container về release trước:

1. Đổi `LUMIBASE_VERSION` về version trước đó.
2. Pull lại CMS image đã pin.
3. Recreate riêng service CMS.

```bash
docker compose pull cms
docker compose up -d cms
```

Docker mode phù hợp cho self-hosting hoặc rehearsal production local. Cloudflare Workers vẫn là đường deploy edge mặc định.

## Cập nhật

Trước khi nâng cấp lên bất kỳ release nào mà mục `Migrations` trong changelog có liệt kê thay đổi database, hãy tạo và kiểm chứng một bản backup PostgreSQL hoặc storage snapshot. Giữ snapshot cho tới khi phiên bản CMS mới khỏe mạnh và migration version khớp với release notes.

Chạy một preflight chỉ đọc với image mới trước khi thay container CMS đang chạy:

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env run --rm -e MIGRATION_MODE=preflight cms
```

Preflight kiểm tra kết nối `DATABASE_URL`, in Drizzle schema version hiện tại, và liệt kê các migration đang chờ mà không áp dụng DDL. Khi container khởi động bình thường, preflight này chạy trước khi áp dụng migration, trừ khi đặt `RUN_MIGRATION_PREFLIGHT=false`.
