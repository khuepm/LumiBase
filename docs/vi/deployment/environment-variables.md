# Biến môi trường

## Runtime CMS

| Biến | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `LUMIBASE_ENV` | Có | Nhãn môi trường như `development`, `staging`, `production`. |
| `LUMIBASE_RUNTIME` | Chỉ Docker | Đặt `docker` khi chạy Node.js self-hosted. Workers suy ra runtime từ binding. |
| `LUMIBASE_DEV_AUTH` | Chỉ local | Chỉ bật `true` khi phát triển local. Không bật ở production. |
| `JWT_SECRET` | Có | Secret cho JWT ứng dụng. Lưu bằng secret store. |
| `CF_ACCESS_CERTS_URL` | Production admin auth | JWKS URL của Cloudflare Access. |
| `CF_ACCESS_AUDIENCE` | Production admin auth | Audience của Cloudflare Access application. |

## Binding Cloudflare

| Binding | Loại | Mục đích |
| --- | --- | --- |
| `HYPERDRIVE` | Hyperdrive | Pool kết nối PostgreSQL cho Worker. |
| `CONFIG_CACHE` | KV | Cache schema, permission và settings. |
| `MEDIA` | R2 | Lưu media. |
| `SITE_ROOM` | Durable Object | Điều phối realtime theo từng site. |

Không commit secret production. Dùng Wrangler secrets cho Workers và secret store riêng cho Docker.
