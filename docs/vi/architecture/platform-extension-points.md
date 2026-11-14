---
version: 1
lastUpdated: 2026-11-14T12:26:57.226Z
sourceLang: en
translatedFrom: en
sourceHash: b9b358bafbe19e63
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T12:26:57.226Z
codeVerifiedHash: b9b358bafbe19e63
codeVerifiedClaims: 30
---

# Điểm mở rộng nền tảng

Operator vận hành LumiBase cho nhiều organization đôi khi cần những chính sách mà
CMS không nên viết cứng — ví dụ, mức trần cho lượng tài nguyên một organization
được dùng. Các điểm mở rộng nền tảng ("seam") cho phép một bản triển khai cung cấp
chính sách đó từ file entry của riêng mình, không phải vá route handler.

Ba tính chất đúng với mọi seam:

- **Không đăng ký gì thì không có gì thay đổi.** Mỗi seam có một cài đặt mặc định
  không làm gì cả. Các entry point có sẵn không đăng ký gì, nên một bản build
  chuẩn chạy y hệt như trước khi có seam.
- **CMS không bao giờ bị khoá tính năng.** Không tính năng có sẵn nào phụ thuộc
  vào việc một seam trả về câu trả lời cụ thể. Với cài đặt mặc định, mọi giới hạn
  đều là không giới hạn.
- **Cài đặt lỗi không bao giờ làm hỏng request.** Nếu một cài đặt ném lỗi, CMS ghi
  log và tiếp tục như thể cài đặt mặc định đã trả lời.

Trang này trình bày registry, các entry point ghép được, phép tra cứu
site → organization có cache, và entitlement resolver.

## Vị trí các thành phần

| Thành phần | Vị trí |
|---|---|
| Hợp đồng (interface và kiểu) | `packages/contracts/src/platform/index.ts`, import qua `@lumibase/contracts/platform` |
| Registry | `apps/cms/src/platform/registry.ts` |
| Cài đặt mặc định | `apps/cms/src/platform/defaults.ts` |
| Helper theo request | `apps/cms/src/platform/request.ts` |
| Middleware entitlement | `apps/cms/src/middleware/entitlement.ts` |
| Tra cứu site → organization | `apps/cms/src/services/domains/site-organization-cache.ts` |

Gói contracts không có phụ thuộc lúc chạy, nên runtime trong `SeamContext` là một
tham số kiểu. CMS gắn nó với `RuntimeContext`.

## Đăng ký một cài đặt

`registerPlatformSeams()` nhận một tập seam không cần đầy đủ. Seam nào bạn bỏ qua
sẽ giữ cài đặt mặc định.

```ts
import { registerPlatformSeams } from '@lumibase/cms/platform';

registerPlatformSeams({ entitlements: myResolver });
```

Quy tắc:

- Gọi **một lần**, ở phạm vi module của file entry. Lần gọi thứ hai sẽ ném lỗi.
- Gọi **trước request đầu tiên**. Khi CMS đã đọc các seam, đăng ký muộn sẽ ném lỗi
  thay vì áp dụng cho request này mà không áp dụng cho request khác.
- Không bao giờ gọi từ request handler, route hay service.

`platform()` trả về tập đầy đủ — cài đặt đã đăng ký đè lên mặc định.
`isPlatformSeamRegistered(name)` cho biết một seam đã được cung cấp hay chưa.

## Entry point ghép được

`@lumibase/cms` export các entry point để một bản triển khai có thể bọc chúng:

| Export | Nội dung |
|---|---|
| `@lumibase/cms/app` | Ứng dụng Hono |
| `@lumibase/cms/cloudflare` | Handler Workers (`fetch`, `scheduled`, `queue`) cùng hai lớp Durable Object `SiteRoom` và `PageviewCounter` |
| `@lumibase/cms/node` | `startNodeServer()` — import không khởi động gì cả |
| `@lumibase/cms/platform` | Registry và các helper theo request |

### Cloudflare Workers

Trỏ `main` trong `wrangler.toml` của bạn tới một file như dưới đây. Giữ nguyên khối
`[alias]` từ `apps/cms/wrangler.toml`; nó giữ các adapter Docker nằm ngoài bundle
của Worker.

```ts
import handler, { PageviewCounter, SiteRoom } from '@lumibase/cms/cloudflare';
import { registerPlatformSeams } from '@lumibase/cms/platform';

registerPlatformSeams({ entitlements: myResolver });

export default handler;
export { PageviewCounter, SiteRoom };
```

Phạm vi module chạy một lần cho mỗi isolate, trước request đầu tiên.

### Node.js và Docker

```ts
import { startNodeServer } from '@lumibase/cms/node';
import { registerPlatformSeams } from '@lumibase/cms/platform';

registerPlatformSeams({ entitlements: myResolver });

await startNodeServer();
```

`startNodeServer()` làm mọi việc mà `apps/cms/src/serve.ts` làm khi chạy trực tiếp:
HTTP server, cron và queue worker. Việc chạy thẳng `serve.ts` không đổi và vẫn
khởi động ngay khi nạp.

### Chỉ một chiều

Mã bên ngoài repository này được phép import nó. Không gì dưới `apps/` hay
`packages/` được import một gói `@lumibase/*` không thuộc workspace này.
`pnpm imports:check` kiểm tra điều đó trong CI.

## Tra cứu site → organization

Mỗi site thuộc về đúng một organization. `siteOrganizationId(db, cache, siteId)`
trả về id của organization sở hữu thông qua cache của runtime, nên đường request
gọi được tên organization mà không tốn một truy vấn cho mỗi request.

| Kết quả | Thời gian cache | Giá trị trả về |
|---|---|---|
| Tìm thấy site | 10 phút | Id của organization |
| Không tìm thấy site | 30 giây | `null` |
| Lỗi cơ sở dữ liệu | Không cache | `null` |

Hàm này không bao giờ ném lỗi.

**Cô lập.** Khoá cache là `site-org:` nối với id của site. Một mục chỉ được ghi từ
dòng có khoá chính đúng bằng id đó, nên tra cứu cho site này không thể đọc hay
ghi đè mục của site khác.

**Vô hiệu hoá.** `invalidateSiteOrganization(cache, siteId)` chạy sau khi thao tác
ghi đã commit, ở mọi nơi làm thay đổi chủ sở hữu:

- chuyển site và xoá site trong `apps/cms/src/routes/orgs.ts`;
- hai thao tác đó khi chạy qua một approval, trong `apps/cms/src/services/organization-harness.ts`;
- tạo site, trong `apps/cms/src/services/site-provisioning.ts`, để xoá mục "không tìm thấy" có từ trước.

**Giới hạn độ cũ.** Một reader đã select dòng cũ ngay trước khi lệnh chuyển site
commit có thể ghi lại nó sau đó. Mục ấy tồn tại tối đa 10 phút. Dùng phép tra cứu
này để quy thuộc. Mã phân quyền cho caller phải tiếp tục đọc cơ sở dữ liệu, như
`organizationRoleForSite` đang làm.

Trong một request, hãy gọi `tenantRefFor(c)`. Nó phân giải lười ở lần dùng đầu tiên
và ghi nhớ kết quả trên context của Hono cho hết request. Trên các route
organization, vốn không mang site, nó trả về organization mà access guard đã xác
minh, hoặc organization của một organization API key — không bao giờ dùng tham số
thô trên đường dẫn.

## Entitlement resolver

Một `EntitlementResolver` trả lời hai câu hỏi:

```ts
interface EntitlementResolver<TRuntime = unknown> {
  resolve(ctx: SeamContext<TRuntime>, organizationId: string | null): Promise<EntitlementSnapshot>;
  authorize(ctx: SeamContext<TRuntime>, req: AuthorizeRequest): Promise<AuthorizeDecision>;
}
```

- `resolve` trả về các giới hạn đang áp dụng cho một organization, dưới dạng bảng
  các khoá mở có namespace (`sites`, `seats`, `storage.bytes`, v.v.). Mỗi giá trị
  là một số hoặc `'unlimited'`.
- `authorize` quyết định một hành động cụ thể có được tiếp tục hay không.

CMS không định nghĩa ý nghĩa của các khoá hay nguồn gốc của các con số. Nó chỉ
hỏi, rồi làm theo câu trả lời.

### Mặc định

Resolver có sẵn trả về một snapshot mà mọi khoá đều đọc ra `'unlimited'`, và cho
phép mọi request. Nó không thực hiện I/O.

Đọc một giới hạn bằng `limitFor(snapshot, dimension)`. Khoá nào snapshot không liệt
kê thì không giới hạn.

### Nơi CMS gọi resolver

`withEntitlement()` được gắn trong `apps/cms/src/index.ts` ở hai chỗ:

| Điểm gắn | Dimension | Surface | Chạy sau |
|---|---|---|---|
| `/api/v1/*` có xác thực | `api.requests` | `rest`, `graphql` hoặc `mcp`, theo đường dẫn | Toàn bộ chuỗi guard |
| `/api/v1/deliver/*` công khai | `delivery.requests` | `delivery` | Rate limiter của delivery |

Khi không có resolver nào được đăng ký, middleware cho qua thẳng: không tra cứu
tenant, không đọc cache. Khi có, nó gọi `authorize` một lần cho mỗi request.

Handler và service đọc snapshot bằng `entitlementsFor(c)`. Snapshot được phân giải
một lần cho mỗi request và giữ trên context. Để hỏi về một hành động cụ thể, gọi
`authorizeEntitlement(c, { dimension, amount, surface })`.

Chưa route có sẵn nào tham khảo snapshot. Các helper tồn tại để công việc về sau
làm được điều đó mà không phải đổi hợp đồng.

### Định dạng từ chối

Khi `authorize` trả về `allowed: false`, middleware trả lời HTTP 429:

```json
{
  "errors": [
    {
      "code": "LIMIT_EXCEEDED",
      "dimension": "api.requests",
      "limit": 1000,
      "retryable": true
    }
  ]
}
```

`helpUrl` chỉ có mặt khi cài đặt cung cấp. REST, GraphQL và MCP nằm sau cùng một
điểm gắn, nên phản hồi giống hệt nhau trên cả ba.

### Xử lý lỗi

| Cài đặt làm gì | CMS làm gì |
|---|---|
| `authorize` ném lỗi hoặc reject | Ghi log và cho request đi tiếp |
| `authorize` trả về thứ không phải một quyết định | Ghi log và cho request đi tiếp |
| `resolve` ném lỗi hoặc trả về snapshot sai dạng | Ghi log và dùng snapshot không giới hạn |

Dòng log bắt đầu bằng `[lumibase-cms] platform seam failed` và mang tên seam, thao
tác, cùng request id.

Một cài đặt muốn từ chối trong lúc kho dữ liệu của chính nó không truy cập được
phải tự trả về `allowed: false`. CMS không thêm chính sách lỗi nào của riêng mình.

### Viết một resolver

```ts
import type { EntitlementResolver } from '@lumibase/contracts/platform';
import type { RuntimeContext } from '@lumibase/runtime';

export const myResolver: EntitlementResolver<RuntimeContext> = {
  async resolve(ctx, organizationId) {
    const limits = await loadLimits(ctx.runtime.cache, organizationId);
    return { organizationId, limits, resolvedAt: Date.now() };
  },
  async authorize(ctx, req) {
    if (req.dimension !== 'api.requests') return { allowed: true };
    const used = await countRequests(ctx.runtime, req.tenant.organizationId);
    return used < 1000
      ? { allowed: true }
      : { allowed: false, code: 'LIMIT_EXCEEDED', dimension: req.dimension, limit: 1000, retryable: true };
  },
};
```

Hướng dẫn:

- Truy cập hạ tầng qua `ctx.runtime` (cache, queue, rate limiter). Đừng import
  binding của Cloudflare hay module chỉ có trên Node, để cùng một mã chạy được trên
  cả hai runtime.
- `authorize` chạy trên mọi request sau khi được đăng ký. Hãy giữ nó ở mức một lần
  đọc cache.
- `req.tenant.organizationId` có thể là `null`: site có thể không xác định, hoặc
  phép tra cứu đã lỗi. Hãy quyết định cài đặt của bạn làm gì trong trường hợp đó.
- `ctx.requestId` là `null` khi ở ngoài request (cron, queue consumer).

## Multi-tenancy

- **Cô lập theo tenant:** mục cache site → organization (khoá theo id của site),
  tenant và snapshot đã ghi nhớ (giữ trên context của từng request).
- **Dùng chung toàn deployment:** registry. Một lần đăng ký áp dụng cho mọi site
  trong process hoặc isolate.

Cách kiểm chứng: `apps/cms/src/services/domains/__tests__/site-organization-cache.test.ts`
và `apps/cms/src/middleware/__tests__/entitlement.test.ts` chạy hai site cạnh nhau
và khẳng định không site nào thấy chủ sở hữu hay quyết định của site kia.
`apps/cms/src/routes/__tests__/site-organization-cache.db.integration.test.ts`
kiểm tra việc vô hiệu hoá trên PostgreSQL.
