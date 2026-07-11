---
version: 1
lastUpdated: 2026-07-08T20:22:56.250Z
sourceLang: en
translatedFrom: en
sourceHash: 3832be55c3103f37
mtEngine: claude
syncStatus: machine-translated
---

# Versioning Policy

> Có hiệu lực từ **v1.0.0**. Trước 1.0.0, LumiBase đang trong quá trình phát triển
> tích cực và các release `0.x` có thể chứa breaking change ở bất kỳ release nào — chỉ có
> release mới nhất được hỗ trợ (xem [`SECURITY.md`](../../../SECURITY.md)).

LumiBase tuân theo [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`)
một cách nghiêm ngặt từ `1.0.0` trở đi. Tài liệu này định nghĩa "breaking" nghĩa là gì với
LumiBase, những phần nào của hệ thống được đảm bảo đó áp dụng, và cách feature
được deprecate và loại bỏ.

## Semver rules

| Bump | Version | Có thể chứa gì | **Không được** làm gì |
|------|---------|---------------------|------------------------|
| **PATCH** | `1.0.x` | Bug fix, security fix, docs. | Thay đổi bất kỳ public surface nào; chạy một migration phá huỷ dữ liệu. |
| **MINOR** | `1.x.0` | Feature mới; endpoint, field, hoặc config mới (mang tính additive); migration additive + idempotent. | Loại bỏ hoặc thay đổi shape của một frozen surface; yêu cầu downtime. |
| **MAJOR** | `2.0.0` | Breaking change: endpoint bị loại bỏ/đổi tên, response shape thay đổi, auth contract thay đổi, migration yêu cầu downtime hoặc re-install. | — |

Mọi release — kể cả một patch — phải vượt qua toàn bộ CI gate (typecheck,
test, lint, build, dependency audit, CodeQL) và, khi nó phát hành một migration,
cả upgrade-path test. Xem [`operations/upgrades.md`](../operations/upgrades.md).

## Public surface

Sau đây là **public surface** được bao phủ bởi đảm bảo semver. Một
breaking change tới bất kỳ mục nào trong số này đều yêu cầu một major bump:

- **REST API** — mọi endpoint dưới `/api/v1`, các request param của chúng, và
  các response envelope `{ data, meta }` / `{ errors }`
  ([`api/hono-api-spec.md`](../api/hono-api-spec.md)).
- **GraphQL API** — schema được ghi trong
  [`api/graphql-api-spec.md`](../api/graphql-api-spec.md).
- **SDK** — các signature được export của `@lumibase/sdk`
  (`client`, `rest`, `graphql`, `typegen`, `realtime`, `seo`, `types`).
- **Header contracts** — `X-Lumi-Site`, `X-Lumi-API-Version`, và các
  response header `X-RateLimit-*` / `Retry-After`.
- **Environment variables** — tên và ngữ nghĩa của các env var được ghi tài liệu
  (`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `CORS_ALLOWED_ORIGINS`,
  `LUMIBASE_RUNTIME`, …).
- **CLI / setup wizard flags** — các argument của `create-lumibase` và các bước của setup wizard.

**Không** thuộc public surface (có thể thay đổi ở bất kỳ minor nào):

- Các internal service và module internal (`apps/cms/src/services`, `modules/`).
- Database schema chi tiết và table layout (migration *path* được đảm bảo;
  internal column shape thì không).
- Studio internal (component structure, internal route, build output).
- Bất cứ thứ gì được ghi là experimental, reserved, hoặc "not yet implemented"
  (ví dụ M2A relation, trả về `501 RELATION_TYPE_NOT_IMPLEMENTED` và được
  reserve cho một release tương lai).

### API version pinning

Các breaking change của REST được phát hành dưới một path prefix mới (`/api/v2`); phiên bản
trước được duy trì trong **ít nhất 12 tháng** sau khi phiên bản kế nhiệm được
release. Client pin bằng `X-Lumi-API-Version: 1`; mặc định là phiên bản stable
mới nhất. Điều này phản ánh §16 của [REST API spec](../api/hono-api-spec.md).

## Deprecation policy

Để loại bỏ bất cứ thứ gì khỏi public surface:

1. **Deprecate trong một minor release** — feature vẫn hoạt động, nhưng:
   - nó phát ra một deprecation warning (log line và/hoặc `Deprecation` response
     header khi áp dụng được),
   - entry trong CHANGELOG liệt kê nó dưới heading `Deprecated`,
   - docs đánh dấu nó là deprecated và chỉ tới phần thay thế.
2. **Remove trong major kế tiếp** — sớm nhất là vậy.

Phải có **ít nhất một chu kỳ minor đầy đủ** giữa deprecation và removal.
Một feature bị deprecate ở `1.3.0` không thể bị loại bỏ trước `2.0.0`, và không bao giờ ở
một patch hay minor.

## Support window

- Security fix được cung cấp cho **major hiện tại** và **major liền
  trước** trong **6 tháng** sau khi một major mới được phát hành.
- Trong một major được hỗ trợ, chỉ **minor mới nhất** nhận fix — nâng cấp
  lên patch mới nhất của minor mới nhất trước khi yêu cầu một backport.

Window này là một cam kết cho line được duy trì; nó có thể được kéo dài cho một
release cụ thể theo quyết định của maintainer, không bao giờ bị rút ngắn trong im lặng.

## Release cadence & gates

- Không có nhịp release cố định theo lịch; release được phát hành khi một tập hợp thay đổi
  mạch lạc đã sẵn sàng và xanh.
- Mọi release đều vượt qua CI gate trong
  [`v1-release-criteria` §3](../../../.kiro/steering/v1-release-criteria.md) và,
  nếu nó mang một migration, cả upgrade-path test ở §4.
- Một release **major** chạy lại toàn bộ checklist v1 release-criteria.

## Quan hệ với Definition of Done

Khi một lớp bug mới được phát hiện sau 1.0.0, bản fix cũng phải thêm một tripwire
(test hoặc lint) và cập nhật Definition of Done trong cùng PR, để lớp bug đó
không thể âm thầm tái diễn. Xem `.kiro/steering/definition-of-done.md`.
