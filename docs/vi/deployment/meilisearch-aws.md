---
version: 1
lastUpdated: 2026-07-28T10:25:03.615Z
sourceLang: en
translatedFrom: en
sourceHash: fd79fbc9b05f2fea
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T10:25:03.615Z
codeVerifiedHash: fd79fbc9b05f2fea
codeVerifiedClaims: 8
---

# Deploy MeiliSearch trên AWS

LumiBase đã có sẵn một backend MeiliSearch nằm sau interface `SearchProvider`
(xem [Full-text Search](../features/search.md)). Runtime Docker nói chuyện với
bất kỳ instance MeiliSearch nào qua HTTP — ở local đó là service `meilisearch`
trong `docker/docker-compose.yml`, nhưng với một môi trường demo hay staging dùng
chung, bạn có thể host MeiliSearch trên AWS rồi trỏ CMS vào đó.

Việc này rất hợp với một khoản credit AWS nhỏ: MeiliSearch là một binary
stateless duy nhất cộng một data volume, nên một instance khiêm tốn chạy nó khá
thoải mái.

> **Ghi chú chi phí (`[Inference]`):** các kích cỡ instance bên dưới là điểm khởi
> đầu, không phải cam kết. Hãy kiểm tra giá hiện tại trong
> [AWS Pricing Calculator](https://calculator.aws) cho region của bạn trước khi
> quyết định — giá AWS thay đổi theo thời gian và theo region.

## Bạn cần gì

- Một account AWS còn credit.
- Một **master key** của MeiliSearch (một chuỗi ngẫu nhiên dài do bạn sinh ra).
  MeiliSearch dẫn xuất các API key có scope từ nó; CMS dùng nó làm
  `MEILISEARCH_API_KEY`.
- Khả năng kết nối mạng từ nơi CMS chạy tới host MeiliSearch (cùng VPC, cùng
  security group, hoặc một public endpoint có xác thực qua TLS).

Sinh một master key:

```bash
openssl rand -base64 48
```

## Phương án A — Amazon Lightsail (đơn giản nhất)

Lightsail cho bạn một VM giá cố định kèm public IP, đây là cách ít rắc rối nhất
để thử MeiliSearch trên AWS.

1. Tạo một instance Lightsail (Ubuntu LTS). Gói 1–2 GB RAM là đủ cho các tập dữ
   liệu dùng để đánh giá `[Inference]`.
2. SSH vào rồi chạy MeiliSearch dưới dạng container với một volume bền:

   ```bash
   sudo docker run -d --name meilisearch \
     --restart unless-stopped \
     -p 7700:7700 \
     -e MEILI_MASTER_KEY="<master-key-của-bạn>" \
     -e MEILI_ENV="production" \
     -v /home/ubuntu/meili_data:/meili_data \
     getmeili/meilisearch:v1.7
   ```

   `MEILI_ENV=production` làm cho master key trở thành **bắt buộc** —
   MeiliSearch từ chối mọi truy cập không xác thực, đúng như bạn muốn trên một
   host có thể kết nối tới.

3. Giới hạn traffic vào: trong firewall của Lightsail, chỉ mở port `7700` cho
   IP/dải IP của host CMS, không mở cho `0.0.0.0/0`.
4. Kết thúc TLS ở phía trước MeiliSearch (Caddy/Nginx, hoặc một Application Load
   Balancer) nếu CMS truy cập nó qua internet công khai. Đừng bao giờ gửi master
   key qua HTTP thuần khi ra khỏi host.

## Phương án B — ECS Fargate (được quản lý, không phải patch VM)

Chạy image `getmeili/meilisearch:v1.7` như một Fargate service với:

- Một **EFS volume** mount ở `/meili_data` để index sống sót qua các lần task
  restart (storage của Fargate task là ephemeral).
- `MEILI_MASTER_KEY` và `MEILI_ENV=production` trong environment của task.
- Một security group chỉ cho phép port `7700` từ task/service của CMS.

Fargate loại bỏ việc bảo trì host, nhưng một task luôn bật cộng EFS sẽ tiêu
credit nhanh hơn một hộp Lightsail nhỏ `[Inference]`. Hãy scale task về không khi
rảnh nếu bạn chỉ cần nó không thường xuyên.

## Phương án C — MeiliSearch Cloud (không dùng credit AWS)

Với runtime Cloudflare, LumiBase mong đợi **MeiliSearch Cloud qua HTTP**. Đó là
một SaaS được quản lý do Meili tính phí — nó **không** tiêu credit AWS. Dùng nó
nếu bạn không muốn tự vận hành service; dùng phương án A hoặc B nếu mục đích là
tiêu khoản credit AWS.

## Trỏ LumiBase vào nó

Runtime Docker đọc hai biến (`packages/runtime/src/adapters/docker/index.ts`):

```bash
MEILISEARCH_HOST=https://search.your-domain.example   # hoặc http://<private-ip>:7700
MEILISEARCH_API_KEY=<master-key-của-bạn>
```

Đặt chúng trong môi trường deploy của bạn (`docker/.env`, service `cms` trong
`docker-compose.prod.yml`, hoặc secret store của orchestrator). Restart CMS để
`MeiliSearchProvider` mới nhận chúng.

## Backfill index

Một instance MeiliSearch mới là rỗng. Hãy reindex nội dung có sẵn:

```bash
pnpm -F @lumibase/cms exec tsx scripts/reindex.ts
```

Các item mới tạo/cập nhật được index liên tục bởi worker content-indexing
(`apps/cms/src/services/content-indexing-worker.ts`), nên lần backfill này chỉ
cần làm một lần cho mỗi instance mới.

## Verify

```bash
# Health (không cần auth)
curl -sS "$MEILISEARCH_HOST/health"

# Stats có xác thực — nên liệt kê các index collection của bạn
curl -sS "$MEILISEARCH_HOST/indexes" \
  -H "Authorization: Bearer $MEILISEARCH_API_KEY"
```

Rồi gọi thẳng endpoint search của CMS để kiểm tra end-to-end:

```
GET /api/v1/search?q=<term>
```

## Ghi chú vận hành

- **Backup:** snapshot data volume (snapshot của Lightsail / backup của EFS).
  Index có thể dựng lại từ Postgres qua `reindex.ts`, nên hãy coi nó là cache,
  không phải system of record.
- **Ghim version:** cứ ở tag image `v1.7` mà adapter đã được test cùng;
  MeiliSearch có thể yêu cầu dump/restore khi upgrade qua major version.
- **Bảo mật:** master key cấp toàn quyền admin. Hãy giữ nó trong một secret
  store, đừng để nó lọt vào code phía client, và ưu tiên mạng private giữa CMS
  và MeiliSearch hơn là một public endpoint.
