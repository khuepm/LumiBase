---
version: 5
lastUpdated: 2026-11-27T13:43:11.800Z
sourceLang: en
translatedFrom: en
sourceHash: 8713b022d078113c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-27T13:43:11.800Z
codeVerifiedHash: 8713b022d078113c
codeVerifiedClaims: 16
---

# ADR-015: Cách ly mã của extension

**Date:** 2026-11-19  
**Status:** Accepted (Node / Docker); Workers vẫn chạy trong process

## Context

Extension phía server loại `hook` và `endpoint` được `ExtensionSandbox`
(`apps/cms/src/extensions/sandbox.ts`) nạp bằng `import()` động **ngay trong
process của CMS**. "Sandbox" ở đây là một cổng capability trên object `ctx`
truyền vào factory của extension — `items`, `db`, `fetch`, `kv`, `env` (chỉ các
khoá `EXTENSION_*`) — chứ không phải ranh giới cách ly: mã của bundle vẫn chạm
được `globalThis.fetch`, timer, `process.env` trên Node, và mọi thứ khác mà
isolate của host chạm được.

Điều khiến việc này chấp nhận được hiện nay là một extension chỉ được nạp khi:

1. origin của bundle nằm trong `EXTENSION_BUNDLE_ORIGINS` (rỗng = không nạp gì);
2. chữ ký của nó hợp lệ (`LUMIBASE_EXT_SIGNATURE_POLICY`, mặc định `require`),
   được kiểm lúc cài, ở mỗi lần nạp, và — từ #990 — mỗi khi một lần cập nhật đổi
   URL hoặc version của bundle;
3. một admin đã cài và bật nó (`/api/v1/extensions` chỉ dành cho admin, và agent
   không thể cài hay cập nhật extension mà không có người duyệt — #991).

FBI FLASH CC-111626-MW nêu việc bám trụ qua plugin là điểm chung của các vụ
chiếm quyền WordPress: plugin giả, must-use plugin ẩn, REST endpoint bị che
giấu. Extension của LumiBase là bề mặt tương đương, nên niềm tin ở mục 1–3
cuối cùng nên được đỡ bởi một ranh giới runtime, không chỉ bởi nguồn gốc.

#990 đã đóng các chỗ rò không cần đến ranh giới đó: handler của endpoint không
còn nhận env binding của CMS, execution context hay header `Authorization` /
`Cookie` của người gọi (`extensionRequest` trong
`apps/cms/src/routes/extensions.ts`), và Studio từ chối bundle UI có byte không
khớp SHA-256 đã ghi nhận (`importVerifiedBundle` trong
`apps/studio/src/lib/extension-loader.tsx`).

## Options

| Phương án | Cloudflare Workers | Node / Docker | Chi phí |
| --- | --- | --- | --- |
| A. Giữ trong process + cổng nguồn gốc (hiện nay) | ✓ | ✓ | không; niềm tin dựa vào chữ ký và admin |
| B. Workers for Platforms (dispatch namespace, mỗi extension một user Worker) | ✓ isolate thật, kiểm soát outbound qua outbound Worker | — | gói trả phí; pipeline deploy cho từng extension |
| C. `isolated-vm` / V8 isolate cho mỗi extension | — (không có native module) | ✓ | phụ thuộc native; marshal `ctx` ở mỗi lời gọi |
| D. `worker_threads` + RPC qua message port cho `ctx` | — | ✓ một phần (chung process, không chung heap) | vừa phải; không giới hạn cứng bộ nhớ/CPU |
| E. Extension host ngoài process (HTTP/RPC, container riêng) | qua service binding | ✓ | thêm một service phải vận hành; mạnh nhất trên Node |

## Decision

1. **Trên Node / Docker, chạy extension `hook` và `endpoint` ngoài process
   (một dạng nhẹ của phương án E): mỗi site, extension và bundle một child
   process**, do CMS fork (`apps/cms/src/extensions/host/process-host.ts`,
   child `host/child.ts`, build thành `dist/extension-host.cjs`). Child khởi
   động với:
   - môi trường rỗng, nên không có `DATABASE_URL`, `JWT_SECRET` hay key nhà
     cung cấp nào;
   - permission model của Node (`--permission`): không ghi file, không tạo
     child process, không worker thread, không native addon, và chỉ đọc file
     trong thư mục của script host;
   - giới hạn heap 128 MB;
   - không có kết nối database và không có state module nào của CMS.

   `ctx` của extension là một proxy: mọi lời gọi `items` / `db` / `fetch` /
   `kv` / `env` đi qua IPC về host và được trả lời bởi chính ctx đã kiểm
   capability như trước, gắn với request đã thực hiện lời gọi. Hook, tool MCP,
   subscriber CDC và request tới endpoint được chuyển tiếp theo cùng cách. Host
   tải bundle một lần (allowlist origin, SSRF guard, tối đa 5 MB), kiểm chữ ký
   và `bundleSha256` đã ghi nhận trên chính buffer đó, rồi đưa đúng các byte
   ấy cho child. Child được định danh theo digest đã xác minh, nên một child
   được dùng lại luôn chạy byte đã kiểm, và child đang giữ byte khác của cùng
   extension sẽ bị kết thúc. Một child bị kết thúc khi nạp lỗi, khi một lời gọi chạy quá
   10 giây, khi extension được cập nhật, hoặc khi CMS thoát. Một bundle đã ghim
   (có `bundleSha256` được ghi nhận) được định địa chỉ theo nội dung, nên các byte
   đã xác minh được giữ trong bộ nhớ theo digest đó (tối đa 64 bundle, 64 MB) và
   các lần nạp sau dùng lại chúng thay vì tải lại. Chữ ký vẫn được kiểm ở mỗi
   lần nạp, nên việc thu hồi một key có hiệu lực ngay. Điều này cũng áp dụng cho
   Node chạy trong process.
2. **`EXTENSION_RUNTIME` chọn chế độ này**: `process` hoặc `in-process`; khi
   không đặt, là `process` ở production (`LUMIBASE_ENV` hoặc `NODE_ENV` =
   `production`) và `in-process` ở nơi khác, để môi trường phát triển và test
   vẫn chỉ có một process.
3. **Cloudflare Workers vẫn chạy trong process** (phương án A với các cổng
   nguồn gốc). Một isolate cho mỗi request đã là lớp cách ly của nền tảng và
   Workers không fork được; phương án B (Workers for Platforms) vẫn là hướng đi
   nếu một bản triển khai cần cách ly theo từng extension ở đó.
4. Không chọn C hay D: C không chạy được trên Workers, còn D dùng chung process
   nên không giới hạn được điều gì quan trọng ở đây.
5. **Chỉ chạy những byte đã được xác minh (#1008), theo từng runtime:**

   | Runtime | Quyết định |
   | --- | --- |
   | Node, process host | Đã vá (#990): một lần tải; chữ ký và SHA-256 được kiểm trên buffer đó; child nhận đúng các byte ấy. |
   | Node, `EXTENSION_RUNTIME=in-process` | Đã vá: cùng phép kiểm một lần tải, rồi `import()` một `data:` URL của các byte đã xác minh (`ExtensionSandbox.loadVerifiedInProcess`), không bao giờ import URL của bundle. |
   | Studio (trình duyệt) | Đã vá: `importVerifiedBundle` tải một lần, kiểm SHA-256, rồi import một `blob:` URL của các byte đó. Vì vậy `script-src` của CSP cho phép `blob:` (CMS và Studio Pages). Bundle của Studio phải là một file duy nhất, vì module `blob:` không phân giải được import tương đối. |
   | Cloudflare Workers | **Chấp nhận rủi ro.** Workers không import được module `data:`/`blob:`, nên bundle được xác minh và import bằng hai lần fetch. Yêu cầu với operator: `EXTENSION_BUNDLE_ORIGINS` chỉ liệt kê origin bạn kiểm soát, phục vụ URL bất biến, định địa chỉ theo nội dung (SHA-256 nằm trong đường dẫn, không bao giờ bị ghi đè). `lumibase doctor --security` cảnh báo khi extension được bật trên Workers. Phương án B (Workers for Platforms) bỏ được yêu cầu này. |

6. **Egress mạng của mã extension (#1009), theo từng runtime: chấp nhận rủi ro
   ở tầng process; giới hạn ở tầng mạng.** Permission model của Node không
   kiểm soát mạng, và một shim `fetch` trong child sẽ không phải là ranh giới.

   | Runtime | Quyết định |
   | --- | --- |
   | Kubernetes (Helm chart) | `networkPolicy.egress.restrict=true` cấp cho pod CMS và worker một egress policy. Nó cho phép DNS, các service kèm sẵn của chính release, các peer trong `networkPolicy.egress.allowTo` và địa chỉ công khai, và chặn `169.254.0.0/16` (metadata của cloud), các dải private, CGNAT và loopback. Mặc định tắt (nó giới hạn toàn bộ CMS, và cần CNI có thực thi egress), khuyến nghị bật ở production. Khi đó chart đặt `LUMIBASE_EGRESS_RESTRICTED=true`. |
   | Node / Docker không dùng chart | Yêu cầu với operator: chặn dải metadata và private cho container CMS (firewall, rule mạng của Docker hoặc một egress proxy), rồi đặt `LUMIBASE_EGRESS_RESTRICTED=true`. |
   | Cloudflare Workers | Chấp nhận rủi ro: `fetch` ra ngoài từ isolate không bị giới hạn. Workers không có mạng private hay endpoint metadata nào để chạm tới; rủi ro còn lại là việc đẩy ra ngoài dữ liệu mà extension nhận qua `ctx`. |

   Ở production, khi có cấu hình extension, CMS ghi một cảnh báo lúc khởi động
   và `lumibase doctor --security` báo `extension-egress-unrestricted` cho tới
   khi đặt `LUMIBASE_EGRESS_RESTRICTED=true`.

## Consequences

- Trên Node ở production, extension không còn đọc được secret của CMS, ghi
  file, tạo process hay vá các phép kiểm capability của host; những gì nó làm
  được là những gì capability đã khai báo cho phép `ctx` làm.
- Permission model không bao phủ mạng: mã trong child vẫn mở được kết nối riêng,
  nhưng không có credential nào của CMS. Thay vào đó, egress được giới hạn ở
  tầng mạng (quyết định 6).
- Ngoài process, `ctx.env.EXTENSION_X` là một promise (cần `await`), `ctx.fetch`
  trả về bản sao của response (tối đa 5 MB), `ctx.logger` của CDC là console
  của child, và factory của extension chạy một lần cho mỗi child thay vì mỗi
  request. Tham số và kết quả phải structured-clone được.
- Bundle `https` từ xa nay nạp được trên Node: host tải nó về, điều mà
  `import()` của Node không làm được.
- Trên Node (cả hai runtime) và trong Studio, không có gì chạy mà chưa được
  xác minh: chỉ có một lần tải, và chữ ký cùng SHA-256 được kiểm trên chính
  buffer được thực thi. Một server trả lời khác ở lần tải sau sẽ bị từ chối ở
  lần nạp đó. Chỉ còn Cloudflare Workers xác minh một response và import URL
  riêng (quyết định 5, chấp nhận rủi ro).
- `script-src` cho phép `blob:`. Một trang chỉ tạo được script `blob:` khi đã
  có script đang chạy, nên việc này không mở thêm đường chèn mã nào;
  `'unsafe-inline'` và `'unsafe-eval'` vẫn tắt.
