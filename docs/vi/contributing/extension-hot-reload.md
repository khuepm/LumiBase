---
sourceLang: en
version: 2
lastUpdated: 2026-11-15T18:31:42.616Z
translatedFrom: en
sourceHash: 61292a384b662999
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T18:31:42.616Z
codeVerifiedHash: 61292a384b662999
codeVerifiedClaims: 40
---

# Hot reload cho extension (`lumibase-ext dev`)

`lumibase-ext dev` theo dõi thư mục mã nguồn của một extension, build lại tăng dần bằng esbuild rồi hot-swap kết quả vào Studio đang chạy (UI slot) và CMS đang chạy (hook, endpoint, operation). Bạn không phải khởi động lại gì cả. Mục tiêu là dưới 2 giây từ lúc lưu file đến lúc thấy thay đổi trong Studio. Test tự động đo toàn bộ pipeline vào khoảng 30–40 ms trên một extension fixture.

> **Chỉ dùng cho phát triển cục bộ.** Hot reload chỉ chạy trên **Node/Docker**. Bản triển khai Cloudflare Workers không bao giờ nạp code từ dev hub. CMS từ chối bật tính năng này trong production; xem [Mô hình bảo mật](#mô-hình-bảo-mật).

## Cách hoạt động

```
 your editor ──save──▶ fs watcher ──▶ esbuild (incremental) ──▶ dev hub (127.0.0.1:4790)
                                                                  │  SSE: hello / reload / build-error
                                    ┌─────────────────────────────┴──────────────────────────┐
                                    ▼                                                        ▼
                    Studio (vite dev server)                                  CMS (Node, NODE_ENV=development)
          import(`/bundle/<name>?v=<version>`)                    fetch bundle → verify sha256 → import
          swap the component in place                             swap the module atomically in the registry
```

| Thành phần | Vị trí |
|------|-------|
| Lệnh CLI | `packages/extension-cli/src/commands/dev.ts` |
| Dev hub (SSE + phục vụ bundle) | `packages/extension-cli/src/dev/hub.ts` |
| Builder tăng dần | `packages/extension-cli/src/dev/builder.ts` |
| Vòng lặp theo dõi → build → thông báo | `packages/extension-cli/src/dev/pipeline.ts` |
| Giao thức truyền (dùng chung) | `packages/contracts/src/extensions/dev-reload.ts` |
| Client phía Studio | `apps/studio/src/lib/extension-dev-client.ts` |
| Hot swap phía Studio | `hotSwapExtension` trong `apps/studio/src/lib/extension-loader.tsx` |
| Guard phía CMS | `apps/cms/src/extensions/dev-reload/config.ts` |
| Client phía CMS | `apps/cms/src/extensions/dev-reload/client.ts` |
| Registry override phía CMS | `apps/cms/src/extensions/dev-reload/registry.ts` |

- **Chỉ build thành công mới được phát.** Một build không biên dịch được sẽ được phát dưới dạng `build-error`. Studio và CMS tiếp tục chạy phiên bản trước và ghi log lỗi.
- **Mỗi build nhận một `version` mới.** Đây là bộ đếm theo phiên, đồng thời là khóa cache-busting của URL bundle (`?v=<version>`). Client bỏ qua phiên bản cũ hơn phiên bản đang chạy, nên một sự kiện đến muộn không bao giờ quay lui.
- **Mỗi sự kiện ghi rõ `session`.** Mỗi lần chạy `lumibase-ext dev` chọn một session id ngẫu nhiên và version bắt đầu lại từ 1. Client thấy session mới sẽ nhận build của nó bất kể version, nên khởi động lại CLI trong khi Studio và CMS vẫn chạy không làm chúng kẹt ở code cũ.
- **Lưu kiểu atomic vẫn được nhận.** Watcher giữ một watch cho mỗi thư mục, nên file mà editor thay bằng cách rename (vim, JetBrains safe write, formatter, `sed -i`) vẫn tiếp tục reload, và thư mục con mới được theo dõi.

## Cách dùng

Thư mục extension cần có `lumibase-extension.json` hợp lệ (`name`, `version`, `type`, `entry`).

```bash
# từ thư mục gốc repo; `exec` chạy trong thư mục package, nên truyền --dir tuyệt đối
pnpm -F @lumibase/extension-cli exec tsx src/cli.ts dev --dir "$PWD/my-extension"
```

| Cờ | Mặc định | Ý nghĩa |
|------|---------|---------|
| `--dir` | thư mục hiện tại | Thư mục extension (có `lumibase-extension.json`) |
| `--port` | `4790` | Cổng của hub (`0` = cổng trống bất kỳ) |
| `--host` | `127.0.0.1` | Interface của hub. Bắt buộc là loopback; giá trị khác bị từ chối |
| `--site` | mọi site | Chỉ áp dụng extension phía server cho một site |
| `--studio` | `http://localhost:2026` | URL Studio dùng để in đường dẫn kết nối |
| `--token` | ngẫu nhiên | Cố định session token (≥ 32 ký tự). Cũng có thể dùng `LUMIBASE_EXTENSION_DEV_TOKEN` |
| `--token-file` / `--no-token-file` | `<tmpdir>/lumibase-ext-dev/<port>.token` | Nơi ghi token cho CMS (mode 0600, bị xóa khi thoát) |

Lệnh in ra URL của hub, **session token theo phiên**, và bước tiếp theo cho loại extension của bạn.

### Extension UI (`interface`, `display`, `layout`, `panel`, `module`)

1. Chạy dev server của Studio: `pnpm studio:dev`.
2. Mở đường dẫn mà `lumibase-ext dev` in ra: `http://localhost:2026/#lumibase-ext-dev=…`. URL hub và token nằm trong **fragment** của URL, phần mà trình duyệt không bao giờ gửi lên server. Studio chuyển chúng vào `sessionStorage` và xóa khỏi thanh địa chỉ.
3. Sửa và lưu. Studio import `<hub>/bundle/<name>?v=<version>` và thay component tại chỗ.

Những gì còn nguyên sau một lần swap: trang, router, query cache và **state của host**, ví dụ giá trị form mà một interface chỉnh qua `value`/`onChange`. Chỉ cây con của chính extension được mount lại, nên state *bên trong* component extension bị reset. Nếu phiên bản trước bị crash khi render, build tốt tiếp theo sẽ xóa lỗi đó.

Bundle UI dùng **React của Studio**. Builder resolve `react`, `react/jsx-runtime` và `react-dom` sang các shim đọc `globalThis.__lumibaseShared`, biến mà dev client của Studio thiết lập. Hai bản React sẽ làm hỏng hooks.

### Extension phía server (`hook`, `endpoint`, `operation`)

Khởi động CMS bằng entry **Node** (không phải `wrangler dev`) kèm cờ dev:

```bash
NODE_ENV=development LUMIBASE_EXTENSION_DEV=1 pnpm -F @lumibase/cms exec tsx src/serve.ts
```

| Biến | Mặc định | Ý nghĩa |
|------|---------|---------|
| `LUMIBASE_EXTENSION_DEV` | chưa đặt | `1`/`true` bật client; nếu không thì tắt |
| `LUMIBASE_EXTENSION_DEV_URL` | `http://127.0.0.1:4790` | URL hub; bắt buộc là loopback |
| `LUMIBASE_EXTENSION_DEV_TOKEN` | chưa đặt | Session token. Khi chưa đặt, CMS đọc token file |
| `LUMIBASE_EXTENSION_DEV_TOKEN_FILE` | `<tmpdir>/lumibase-ext-dev/<port>.token` | Token file do CLI ghi |

CMS kết nối lại mỗi giây và đọc lại token file ở mỗi lần thử, nên bạn có thể khởi động CMS và CLI theo thứ tự bất kỳ.

- **Swap nguyên tử.** Registry là một map bất biến duy nhất, được thay toàn bộ ở mỗi lần reload (copy-on-write). `ExtensionSandbox` của mỗi request ghim generation hiện hành tại lúc request bắt đầu. Một request bắt đầu ở phiên bản N chạy **mọi** hook của nó, cả before lẫn after, trên N. Các request bắt đầu sau lần swap nhận N+1.
- **Toàn vẹn.** CMS fetch bundle của đúng phiên bản trong sự kiện và kiểm tra SHA-256 với sự kiện trước khi import bất cứ thứ gì. Mỗi phiên bản được import thành một module riêng (URL `data:`), nên module cache của Node không bao giờ trả về code cũ.
- **Không cần cài đặt.** Một extension `hook` đang phát triển chạy được cả khi bạn chưa cài nó. Nếu một extension cùng tên *đã* được cài, bản build dev thay bundle của nó trong phiên này.

## Mô hình bảo mật

Đường dev import code được đẩy vào từ bên ngoài tiến trình CMS. Về bản chất đó là thực thi code từ xa, nên nó bị rào ở mọi trục và mặc định đóng khi lỗi:

1. **Bật tường minh.** Bắt buộc có `LUMIBASE_EXTENSION_DEV=1`.
2. **Không bao giờ chạy production.**
   - Client bị từ chối khi `NODE_ENV` hoặc `LUMIBASE_ENV` là `production`.
   - `NODE_ENV` phải được đặt tường minh là `development` (hoặc `test`).
   - `validateProductionConfig` làm hỏng lần khởi động production có đặt cờ này.
   - Chính registry ném lỗi nếu bị kích hoạt trong production. Khi registry chưa kích hoạt, `ExtensionSandbox` không bao giờ thấy override.
3. **Chỉ loopback.**
   - Hub từ chối bind vào interface không phải loopback.
   - Hub từ chối request có `Host` hoặc `Origin` không phải loopback, qua đó chặn DNS rebinding.
   - CMS và Studio từ chối URL hub không phải loopback.
4. **Có xác thực.**
   - Mọi request tới hub cần session token theo phiên: `Authorization: Bearer`, hoặc `?token=` cho `EventSource`/`import()`.
   - Token gồm 32 byte ngẫu nhiên và được so sánh trong thời gian hằng số.
   - Token file có mode 0600 và bị xóa khi phiên kết thúc.
5. **Chỉ trên dev server của Studio.** Client chỉ khởi động dưới `import.meta.env.DEV`, nên bản build production loại bỏ nó.
6. **Chỉ Node/Docker.** Chỉ `apps/cms/src/serve.ts` khởi động client phía CMS. Entry của Workers không bao giờ import nó.

Một lần khởi động bị từ chối sẽ ghi log `[extension-dev] hot reload REFUSED: <reason>` và CMS vẫn chạy tiếp mà không có hot reload.

## Giới hạn

- Mỗi tiến trình `lumibase-ext dev` phục vụ một extension. Chạy một tiến trình cho mỗi extension, mỗi cái trên một `--port` riêng.
- Mọi phiên bản đã reload nằm lại trong module map của Node cho đến khi CMS khởi động lại. Điều này chấp nhận được trong một phiên dev.
- `--site` chỉ thu hẹp extension phía server. UI slot của Studio gắn với từng phiên trình duyệt.

## Test

| Nội dung | Test |
|------|------|
| Sửa → hiển thị trong Studio (mock), kiểm tra < 1000 ms so với ngân sách 2 s | `packages/extension-cli/src/dev/__tests__/pipeline.latency.test.ts` |
| Xác thực hub, từ chối non-loopback/DNS rebinding, bundle theo phiên bản | `packages/extension-cli/src/dev/__tests__/hub.test.ts` |
| Từ chối production, swap hook nguyên tử, toàn vẹn của client CMS | `apps/cms/src/extensions/dev-reload/__tests__/dev-reload.test.ts` |
| Swap trong Studio giữ nguyên state của host, session qua fragment, guard chỉ cho dev | `apps/studio/src/lib/__tests__/extension-dev-client.test.tsx` |
