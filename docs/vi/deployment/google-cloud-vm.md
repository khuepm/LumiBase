---
version: 1
lastUpdated: 2026-08-02T19:21:09.252Z
sourceLang: en
translatedFrom: en
sourceHash: 2bc7ce42ef0ae829
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:21:09.252Z
codeVerifiedHash: 2bc7ce42ef0ae829
codeVerifiedClaims: 8
---

# Google Cloud Deployment (single VM)

Hướng dẫn này triển khai toàn bộ stack LumiBase lên **một** VM **Google Compute
Engine** bằng `docker compose`, dùng **Gemini** làm LLM provider. Đây là cách
triển khai rẻ nhất vẫn thoả yêu cầu "chạy trên Google Cloud" mà không làm hỏng
các background job dài hạn của LumiBase.

## Vì sao dùng VM chứ không phải Cloud Run

Entrypoint Node (`apps/cms/src/serve.ts`) chạy nhiều job `node-cron` trong cùng
một tiến trình dài hạn:

- tick của content scheduler (`* * * * *`)
- sweep commit veto-window (`*/5 * * * *`)
- rotation retention của audit log (`0 * * * *`)
- worker agent-run bất đồng bộ tiêu thụ queue Redis

Một target serverless scale-to-zero / multi-instance (Cloud Run với cấu hình mặc
định) sẽ **bỏ qua các job này khi idle** và **chạy trùng lặp khi có hơn một
instance**. Muốn dùng Cloud Run an toàn thì phải ghim
`min-instances=1, max-instances=1` cộng thêm Cloud SQL, Memorystore, GCS và
MeiliSearch bên ngoài — nhiều thành phần hơn, đắt hơn, mà ở quy mô này không
được lợi gì. Một VM nhỏ chạy stack đóng gói sẵn thì đơn giản và rẻ hơn.

> Khi vượt quá sức một VM, đường nâng cấp là: đưa Postgres sang Cloud SQL, Redis
> sang Memorystore, media sang GCS, và giữ CMS trên VM (hoặc một service Cloud
> Run ghim single-instance). Tính chuyện đó lúc cần, không phải bây giờ.

## Cần chuẩn bị

- Một Google Cloud project đã bật billing.
- CLI `gcloud` đã đăng nhập ở máy local (`gcloud auth login`).
- Một Gemini API key lấy tại <https://aistudio.google.com/apikey>.

## 1. Tạo VM

`e2-small` (2 vCPU burst, 2 GB RAM) là mức tối thiểu thực dụng cho cả stack; dùng
`e2-medium` (4 GB) nếu thấy bị OOM kill khi tải cao. Đổi `--zone` sang region gần
người dùng của bạn.

```bash
gcloud compute instances create lumibase \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB \
  --zone=asia-southeast1-a \
  --tags=lumibase-http
```

Mở port CMS (1989). Nếu dùng domain thật, hãy đặt reverse proxy TLS phía trước
(xem [Lưu ý về TLS](#lưu-ý-về-tls)) và chỉ mở 80/443 thay vì 1989.

```bash
gcloud compute firewall-rules create lumibase-http \
  --allow=tcp:1989 \
  --target-tags=lumibase-http \
  --description="LumiBase CMS API"
```

## 2. Cài Docker trên VM

SSH vào và chạy script setup (cài Docker Engine + compose plugin):

```bash
gcloud compute ssh lumibase --zone=asia-southeast1-a

# trên VM:
git clone https://github.com/khuepm/LumiBase.git lumibase
cd lumibase
bash docker/scripts/gcp-vm-setup.sh
# đăng nhập lại (hoặc `newgrp docker`) để user chạy docker không cần sudo
```

## 3. Cấu hình secret

```bash
cd ~/lumibase/docker
cp .env.prod.example .env
```

Điền **mọi** giá trị trong `.env`. File này ghi kèm lệnh `openssl` cho từng
secret. Có hai lớp guard lúc boot sẽ chặn stack cấu hình sai:

- overlay `docker-compose.gcp.yml` abort nếu một biến bắt buộc bị rỗng;
- CMS chạy `validateProductionConfig()` khi khởi động và từ chối boot nếu thiếu
  secret, còn sót giá trị dev mặc định (`minioadmin`, `lumibase_dev_key`,
  `736563726574`), `ENCRYPTION_KEY` không phải AES, hoặc CORS origin là `*`.

Đặt `LLM_PROVIDER=gemini` và dán `GEMINI_API_KEY` của bạn.

## 4. Build và khởi động

```bash
docker compose -f docker-compose.yml -f docker-compose.gcp.yml up -d --build
```

Lệnh này build image production (`docker/Dockerfile`) ngay trên VM, chạy database
migration qua entrypoint, rồi khởi động CMS cùng Postgres, Redis, MinIO,
MeiliSearch và imgproxy trên một Compose network riêng. Chỉ port CMS được publish.

## 5. Kiểm chứng

```bash
# health
curl -fsS http://localhost:1989/health

# theo dõi log CMS (tìm dòng "Started in docker mode on port 1989")
docker compose -f docker-compose.yml -f docker-compose.gcp.yml logs -f cms
```

Từ máy của bạn, gọi vào IP ngoài:

```bash
gcloud compute instances describe lumibase --zone=asia-southeast1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
curl -fsS http://<EXTERNAL_IP>:1989/health
```

### Xác nhận Gemini thật sự được wiring

`LLM_PROVIDER=gemini` cùng key hợp lệ sẽ route các lời gọi AI Copilot / agent
reasoning tới `generativelanguage.googleapis.com`. Nếu thiếu key hoặc key sai,
provider factory rơi về provider `echo` (không LLM) và log
`GEMINI_API_KEY not set, falling back to echo provider` — grep log CMS tìm dòng
đó để chắc chắn bạn KHÔNG đang chạy fallback. Sau khi thử Copilot, đối chiếu token
usage trong **Google AI Studio → API keys** (hoặc billing ở Cloud console nếu
dùng key tính phí qua Cloud).

## Vận hành stack

```bash
# cập nhật code mới nhất
cd ~/lumibase && git pull
docker compose -f docker/docker-compose.yml -f docker/docker-compose.gcp.yml up -d --build

# dừng
docker compose -f docker/docker-compose.yml -f docker/docker-compose.gcp.yml down

# backup — volume Postgres là source of truth; xem docker/scripts/backup.sh
```

## Lưu ý về TLS

Port 1989 là HTTP thuần. Với bất cứ thứ gì hướng ra khách hàng, hãy terminate TLS
bằng reverse proxy và ngừng mở 1989 ra ngoài. Repo có sẵn overlay Caddy
(`docker/docker-compose.tls.yml`, `docker/Caddyfile`) tự động lấy chứng chỉ Let's
Encrypt — đặt `PUBLIC_DOMAIN` và `ACME_EMAIL`, trỏ DNS A record về IP ngoài của
VM, rồi thêm overlay đó vào lệnh compose.

## Bằng chứng cho submission (Build with Gemini XPRIZE)

Bản triển khai này tạo ra một số artifact mà ban giám khảo cần kiểm chứng (xem
[`devpost-xprize-submission.md`](../../en/devpost-xprize-submission.md) — chỉ có bản tiếng Anh):

- **AI chạy trong production** — các row agent execution trong `agent_runs` /
  `agent_goals`, export được từ Postgres; screenshot Mission Control từ Studio.
- **Có dùng Gemini** — số token/request từ Google AI Studio hoặc billing ở Cloud
  console, gắn với key trong `.env`.
- **Sản phẩm live trên Google Cloud** — URL ngoài của VM trả lời `/health`.
