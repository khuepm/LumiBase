---
version: 3
lastUpdated: 2026-11-21T03:36:06.095Z
sourceLang: en
translatedFrom: en
sourceHash: 64456fef2a7ac15c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-21T03:36:06.095Z
codeVerifiedHash: 64456fef2a7ac15c
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
   10 giây, khi extension được cập nhật, hoặc khi CMS thoát.
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

## Consequences

- Trên Node ở production, extension không còn đọc được secret của CMS, ghi
  file, tạo process hay vá các phép kiểm capability của host; những gì nó làm
  được là những gì capability đã khai báo cho phép `ctx` làm.
- Permission model không bao phủ mạng: mã trong child vẫn mở được kết nối riêng,
  nhưng không có credential nào của CMS. Hãy giới hạn egress ở tầng container
  nếu điều đó quan trọng.
- Ngoài process, `ctx.env.EXTENSION_X` là một promise (cần `await`), `ctx.fetch`
  trả về bản sao của response (tối đa 5 MB), `ctx.logger` của CDC là console
  của child, và factory của extension chạy một lần cho mỗi child thay vì mỗi
  request. Tham số và kết quả phải structured-clone được.
- Bundle `https` từ xa nay nạp được trên Node: host tải nó về, điều mà
  `import()` của Node không làm được.
- Ngoài process, không có gì chạy mà chưa được xác minh: chỉ có một lần tải,
  và chữ ký cùng SHA-256 được kiểm trên chính buffer mà child nhận. Một server
  trả lời khác ở lần tải sau sẽ bị từ chối ở lần nạp đó. Đường chạy trong
  process (Workers, `EXTENSION_RUNTIME=in-process`) vẫn xác minh một response
  và import URL riêng.
- Kiểm tra toàn vẹn của Studio bắt được bundle bị thay ở URL của nó, nhưng không
  bắt được server trả lời request kiểm tra và lần import module khác nhau; đóng
  khe hở đó cần import qua `blob:` và do đó cần `blob:` trong `script-src` của
  CSP Studio, việc này vẫn để lại sau.
