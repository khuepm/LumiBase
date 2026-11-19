---
version: 1
lastUpdated: 2026-11-19T20:13:27.270Z
sourceLang: en
translatedFrom: en
sourceHash: 67a1126eba46851a
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-19T20:13:27.270Z
codeVerifiedHash: 67a1126eba46851a
codeVerifiedClaims: 8
---

# ADR-015: Cách ly mã của extension

**Date:** 2026-11-19  
**Status:** Proposed

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

## Decision (đề xuất)

1. **Giữ phương án A làm mặc định**, kèm phần gia cố của #990, và ghi rõ rằng
   extension chạy với chính quyền hạn của CMS. Cài một extension là một lần
   deploy mã.
2. **Hướng tới phương án B trên Cloudflare và phương án E trên Docker** cho
   extension `hook` và `endpoint`, sau cùng một interface: host gọi một
   `ExtensionRuntime` (`invokeHook`, `handleRequest`) với request `ctx` đã
   serialise, và phía bị cách ly gọi ngược lại qua RPC cho các thao tác
   `items` / `db` / `kv`, mỗi thao tác được kiểm phía host theo capability đã
   cấp cho extension.
3. Không chọn C hay D: C không chạy được trên Workers, còn D dùng chung process
   nên không giới hạn được điều gì quan trọng ở đây.

Phần triển khai tiếp theo được theo dõi trong epic #985; ADR này giữ trạng thái
**Proposed** cho tới khi interface `ExtensionRuntime` được đưa vào.

## Consequences

- Cho tới lúc đó, ranh giới là nguồn gốc (allowlist origin + chữ ký + admin),
  và audit trail (`admin_change` cho cài / cập nhật / bật, #988) là cách phát
  hiện một extension bất thường.
- Extension cần secret của host phải dùng các khoá `EXTENSION_*` qua `ctx.env`
  (capability `env:read`); nó không còn đọc được chúng từ binding của handler.
- Kiểm tra toàn vẹn của Studio bắt được bundle bị thay ở URL của nó, nhưng không
  bắt được server trả lời request kiểm tra và lần import module khác nhau; đóng
  khe hở đó cần import qua `blob:` và do đó cần `blob:` trong `script-src` của
  CSP Studio, việc này để lại cho cùng đợt tiếp theo.
