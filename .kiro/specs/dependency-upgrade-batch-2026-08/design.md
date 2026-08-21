# Design Document

**Feature:** Dependency Upgrade Batch (2026-08)

## Overview

Batch này gộp 13 PR Dependabot + 4 PR consolidation chồng lấn thành **hai lần merge có thứ tự**, cộng hai thay đổi mà **không PR nào hiện có chứa**: nâng Node_Floor và thêm guard chống Override_Drift.

Thiết kế dựa trên một lần rebase khô đã thực hiện (`origin/chore/deps-consolidated-upgrade` → `origin/claude/cache-stack-8-layers-n6ggtk`, worktree tạm, đã dọn). Kết quả đo được, không phải suy đoán:

- Conflict đúng **2 file**: `package.json` và `pnpm-lock.yaml`.
- Conflict trong `package.json` đúng **2 hunk**, cả hai giải quyết cơ học (chi tiết §3).
- `pnpm-lock.yaml` không giải quyết bằng tay — regenerate.
- Ba commit còn lại của #396 apply sạch.

Phát hiện quan trọng nhất từ lần rebase khô: **#396 không đụng `pnpm-workspace.yaml`**, trong khi #397 tạo file đó làm bản khai thứ hai của `overrides`. Sau rebase, `package.json` mang giá trị mới của #396 còn `pnpm-workspace.yaml` mang giá trị cũ của #397 → `pnpm settings:check` (do chính #397 thêm vào CI) **sẽ fail**. Đây là công việc bắt buộc mà cả hai PR đều thiếu, và nó chỉ lộ ra khi hai PR gặp nhau.

## Architecture

### Merge topology

```
main (b8c5137c)
 │
 ├── (1) merge #397  ── advisory + Settings_Parity + settings:check gate
 │        │             nhỏ, CLEAN, không đụng major nào
 │        ▼
 │      main'
 │        │
 ├── (2) rebase #396 lên main'
 │        │  · giải quyết 2 hunk package.json
 │        │  · đồng bộ pnpm-workspace.yaml  ← việc mới, không PR nào có
 │        │  · hấp thu số của #399 (mới hơn #396)
 │        │  · thêm Node_Floor + guard drift
 │        │  · pnpm install → lockfile mới
 │        ▼
 │      #396'  ── force-push
 │        │
 ├── (3) merge #396' ─→ đóng #369–#381
 │
 ├── (4) merge #398   ── bump action đơn lẻ, độc lập
 │
 └──     đóng #382 (trùng #396), #383 (đã bị #385 vượt), #399 (đã hấp thu ở bước 2)
```

Thứ tự (1) trước (2) là ràng buộc, không phải sở thích: cả hai PR sửa `pnpm.overrides` ở root, và dạng override của #397 là dạng đúng (§3.1) nên nó phải là base.

### Vì sao #399 bị hấp thu thay vì merge riêng

#399 và #396 chồng lấn ở nửa minor/patch, và **#399 mới hơn ở 7 package**:

| Package | #396 | #399 | Lấy |
|---|---|---|---|
| `turbo` | ^2.10.8 | 2.10.9 | 2.10.9 |
| `wrangler` | ^4.119.0 | 4.123.0 | 4.123.0 |
| `next` | 16.3.0 | 16.3.1 | 16.3.1 |
| `@shikijs/rehype` | ^4.4.2 | 4.4.3 | 4.4.3 |
| `@hookform/resolvers` | ^5.7.1 | 5.8.0 | 5.8.0 |
| `react-hook-form` | ^7.84.0 | 7.85.0 | 7.85.0 |
| `@aws-sdk/client-s3` | ^3.1105.0 | 3.1110.0 | 3.1110.0 |
| `ws` | ^8.21.2 | 8.21.3 | 8.21.3 |
| `postcss` | ^8.5.26 | 8.5.26 | ^8.5.26 |
| `esbuild` | (override ^0.28.1) | 0.28.2 | ^0.28.2 |

Merge #396 rồi merge #399 sẽ tạo ra hai lần regenerate lockfile liên tiếp cho cùng một nhóm package. Lấy số của #399 ngay trong bước (2) là một lần install, một lần CI.

#398 (`codeql-action/upload-sarif`) đứng riêng vì nó chỉ đụng `.github/workflows/`, không đụng lockfile.

### Ranh giới tự động hoá — ba việc cần người

| Việc | Vì sao |
|---|---|
| Merge #397 vào `main` | Ghi vào branch dùng chung. Nếu muốn tránh, có thể stack #396 lên thẳng nhánh của #397 và merge một lần — nhưng khi đó #397 mất review độc lập. |
| Force-push #396' | Rebase viết lại history của một nhánh đã push. Cần cho phép tường minh. |
| Đóng #382, #383, #369–#381, #399 | Hành động lộ ra ngoài, khó thu hồi. #369–#381 phải chờ #396' merge thật, không đóng trước. |

Mọi việc còn lại — giải quyết conflict, đồng bộ workspace yaml, hấp thu số của #399, sửa source cho major, nâng Node_Floor, viết guard, chạy toàn bộ gate — làm được cục bộ và có thể revert.

## Data Models

Batch này không đụng schema DB. "Data model" ở đây là ba bảng cấu hình quyết định repo cài cái gì: bảng `overrides` (khai hai chỗ), Node_Floor, và bảng hoà giải số giữa #396 và #399.

### Hoà giải override

#### Hai hunk conflict, và lời giải

```
hunk 1   HEAD  (#397): "@types/react": "19.2.0",  "@types/react-dom": "19.2.0"
         #396        : "@types/react": "19.2.18", "@types/react-dom": "19.2.4"
         → lấy #396
```

`@types/react` là override **giữ `@lumibase/ui` typecheck cùng React major với runtime** (backlog B15, `docs/en/security/dependency-overrides.md`). Manifest sau batch khai `^19.2.18`; nếu override đứng ở `19.2.0` thì nó ghim types tụt lại và Req 4 (guard drift) sẽ bắt ngay — vì `19.2.0` exact không giao với `^19.2.18`.

```
hunk 2   HEAD  (#397): "nanoid@3": "^3.3.17",  "nanoid@5": "^5.1.16"
         #396        : "nanoid": "^5.1.16"
         → lấy #397
```

Dạng phẳng của #396 áp `^5.1.16` cho **mọi** range nanoid, kể cả `next → postcss → nanoid@3`. postcss yêu cầu nanoid 3.x; kéo nó lên 5.x là đổi major của một transitive dep mà không ai kiểm. Dạng scoped của #397 đóng cả hai advisory (`GHSA-2v37-7h3g-55p8` ở 3.x, `GHSA-28wg-ghj8-5hjv` ở 5.x) mà không đụng major nào.

#### Bảng override cuối, khai ở hai chỗ

Sau rebase, **cả** `package.json` (pnpm 9 đọc) **và** `pnpm-workspace.yaml` (pnpm 10+ đọc) phải mang bảng này. Cột cuối cho biết entry có bị guard §4 soi hay không.

| Package | Giá trị | Nguồn | Có workspace package khai trực tiếp? |
|---|---|---|---|
| `@types/react` | `19.2.18` | #396 | có — `packages/ui`, `apps/{studio,docs,landing}` |
| `@types/react-dom` | `19.2.4` | #396 | có |
| `dompurify` | `^3.4.13` | #397 | có — `apps/{studio,docs}` |
| `esbuild` | `^0.28.2` | #399 | không (transitive: vite, tsx) |
| `fast-uri` | `>=4.1.2` | main (#385) | không |
| `form-data` | `^4.0.6` | main | không |
| `js-yaml` | `^4.3.1` | #397 | không (transitive: gray-matter, đã patch) |
| `nanoid@3` | `^3.3.17` | #397 | không (transitive: postcss) |
| `nanoid@5` | `^5.1.16` | #397 | có — `apps/cms`, `packages/database` |
| `postcss` | `^8.5.26` | #399 | có — `apps/{studio,docs,landing}` |
| `sharp` | `>=0.35.0` | main | không |
| `undici` | `^7.28.0` | main | không |
| `uuid` | `^14.0.1` | #396 | có — `apps/cms` |
| `vite` | `^8.2.0` | #396+#399 | có — `apps/{studio,docs}` ← ca drift |
| `ws` | `^8.21.3` | #399 | có — `apps/cms` |

`patchedDependencies` (`gray-matter@4.0.3`) và `auditConfig.ignoreGhsas` (`GHSA-qwww-vcr4-c8h2`) giữ nguyên, vẫn khai hai chỗ.

`scripts/check-pnpm-settings-parity.mjs` (#397 thêm) là thứ chặn việc quên nửa sau. Nó đã có trong CI nên không cần thiết kế thêm.

### Node_Floor

| Nơi khai | Hiện tại | Sau batch | Lý do |
|---|---|---|---|
| `engines.node` (root) | `>=22` | `>=22.13.0` | `>=22` cho phép 22.0–22.12, dải làm vỡ cả `vite@8` (`>=22.12.0`) và `eslint@10` (`^22.13.0`). 22.13 là sàn thấp nhất thoả cả hai. |
| `.nvmrc` | `22` | `24` | Khớp `NODE_VERSION: 24` trong `ci.yml`. `22` là floating, contributor bốc được 22.0 là vỡ. |
| `packages/mcp-server` `engines.node` | `>=18` | giữ `>=18`, ghi lý do | Đây là package **published**; sàn của nó là contract với consumer, không phải với toolchain workspace. Nó không dùng vite/eslint 10. |

`engines` và `.nvmrc` lệch nhau là có ý: `engines` là "chạy được", `.nvmrc` là "nên dùng bản này để giống CI".

Node local hiện tại 22.23.2 → thoả `>=22.13.0`, batch verify được ngay không cần đổi máy.

Theo Req 5.5, thay đổi này nằm **trong** #396' cùng cú flip vite 8 / eslint 10 — tách ra PR sau nghĩa là có một khoảng thời gian repo yêu cầu toolchain mà `engines` không mô tả.

## Components and Interfaces

### Guard chống Override_Drift

#### Bài toán

Override của pnpm áp cho **cả direct dependency**, không chỉ transitive. Nên `overrides.vite: ^7.3.5` lặng lẽ đè `apps/studio` + `apps/docs` khai `^8.1.3`, và lockfile importer ghi `specifier: ^7.3.5 → 7.3.6`. Manifest nói 8, thực cài 7, không cảnh báo nào. `settings:check` không bắt được vì hai bản khai override *giống nhau* — chúng chỉ cùng sai so với manifest.

#### Thiết kế

`scripts/check-override-drift.mjs`, chạy trong CI cạnh `settings:check` và `registry:check`.

Thuật toán:

1. Đọc `overrides` từ root `package.json`.
2. Với mỗi key, tách tên và range-scope: `nanoid@3` → `{ name: 'nanoid', scope: '3' }`, `vite` → `{ name: 'vite', scope: null }`.
3. Đọc mọi workspace manifest theo `pnpm-workspace.yaml` (nhớ loại `!apps/marketplace`), gom `dependencies` + `devDependencies` + `peerDependencies`.
4. Với mỗi khai báo trực tiếp trùng tên:
   - nếu override có scope và scope KHÔNG giao với range khai báo → **bỏ qua** (override đó nhắm range khác);
   - ngược lại, nếu range override KHÔNG giao với range khai báo → **fail**.
5. Override không có workspace package nào khai trực tiếp → bỏ qua (đó là cách dùng đúng của override bảo mật).

Phép giao dùng `semver.intersects()`. `semver` được thêm làm devDependency của root, pin exact. Không tự parse range: `>=4.1.2`, `^19.2.18`, `19.2.0` exact, và scope `nanoid@3` là bốn dạng khác nhau, tự parse là mời bug vào chính cái guard chống bug.

#### Giao diện dòng lệnh

Chạy qua `pnpm check:override-drift`. Exit 0 khi mọi override giao được với manifest; exit khác 0 kèm báo cáo từng package lệch (mẫu output ở §Error Handling).

#### Test cho guard

Guard phải được chứng minh bắt đúng ca đã xảy ra, không chỉ chạy xanh:

- fixture `vite` override `^7.3.5` + manifest `^8.1.3` → fail (đây là ca thật trên `main`).
- fixture `@types/react` override `19.2.0` exact + manifest `^19.2.18` → fail.
- fixture `nanoid@3: ^3.3.17` + manifest `^5.1.16` → pass (scope khác range).
- fixture `nanoid@5: ^5.1.16` + manifest `^5.0.7` → pass (giao nhau).
- fixture `esbuild` override, không manifest nào khai → pass.

Đây là tripwire theo DoD §6: nó khoá cả class, không chỉ ca `vite`.

### Sửa source cho Breaking_Major

#### `@cloudflare/workers-types` 4 → 5

v5 tự khai `Buffer: any`, và nó là **`types` entry duy nhất** của `apps/cms/tsconfig.json`, nên typings `Buffer` của Node rơi khỏi phạm vi. Hệ quả: `Buffer.isBuffer()` không còn narrow, `buf.toString('utf-8')` báo "Expected 0 arguments".

| File | Sửa |
|---|---|
| `packages/runtime/src/adapters/cloudflare/storage.ts` | `Buffer.isBuffer(x)` → `ArrayBuffer.isView(x)` — narrow theo shape của view, đúng Web-standard, không cần Node typings |
| `apps/cms/src/modules/git-integration/ci-log-store.ts` | `buf.toString('utf-8')` → `new TextDecoder().decode(buf)` |
| `apps/cms/src/services/__tests__/extension-signature.test.ts` | `buf.toString('base64')` → `btoa(...)` |

Nguyên tắc: đi sang Web-standard equivalent, **không** thêm `@types/node` vào `types` của Worker build. Worker không có Node Buffer lúc runtime; việc typings v4 vờ như có là điều kiện sai lệch mà v5 sửa đúng.

v5 còn nới global `ExecutionContext` thêm `tracing`/`abort` bắt buộc. Hono `c.executionCtx` là shape hẹp hơn, và giá trị chỉ chảy trở lại `subApp.fetch()` — nơi cần đúng shape của Hono. Cách xử lý: **để helper tự infer return type** thay vì annotate bằng `ExecutionContext` global. Không `as any`, không cast (Req 6.2).

#### `lucide-react` 0.452 → 1.28

1.x bỏ brand marks. `Github` là export bị xoá duy nhất còn dùng — đã enumerate toàn bộ call site lucide để xác nhận (Req 6.4).

Chỉ một file: `apps/landing/src/components/Header.tsx` — import dòng 5, render 2 chỗ (desktop ~dòng 100, mobile ~dòng 155).

Cách sửa: **inline SVG mark GitHub** ngay trong file, giữ nguyên `className="h-4 w-4"` để layout không đổi. Không thay bằng glyph generic (`Star`, `Code`, `ExternalLink`): link đó có label chữ "GitHub" cạnh icon, đổi mark thành hình khác là đổi diện mạo mà không ai review nhận ra qua diff dependency.

#### `fast-check` 3 → 4

v4 hợp nhất các string builder theo-đơn-vị về `string({ unit })`. Migration cơ học:

| v3 | v4 |
|---|---|
| `fc.stringOf(unit, c)` | `fc.string({ unit, ...c })` |
| `fc.hexaString(c)` | `fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), ...c })` |
| `fc.char().filter(pred)` | `fc.constantFrom(...<charset tường minh>)` |

`fc.char().filter(...)` không map 1-1: filter trên toàn bộ không gian char rồi loại là vừa chậm vừa mơ hồ về charset thật. Thay bằng `constantFrom` của tập ký tự đã định nghĩa rõ — cùng thứ generator đang thật sự sinh ra, chỉ là viết tường minh.

13 file đã xác nhận bị ảnh hưởng (grep trên `main`):

```
apps/cms/src/routes/__tests__/ai-chat-validation.property.test.ts
apps/cms/src/routes/__tests__/ai-approvals-list.property.test.ts
apps/cms/src/routes/__tests__/ai-chat-response.property.test.ts
apps/cms/src/services/__tests__/constitution-pinning.property.test.ts
apps/cms/src/modules/anomaly/__tests__/baseline-store.test.ts
apps/docs/src/lib/__tests__/url.property.test.ts
apps/docs/src/lib/__tests__/resolveDoc.property.test.ts
apps/docs/src/lib/__tests__/search.property.test.ts
apps/docs/src/lib/__tests__/search.locale.property.test.ts
apps/docs/src/plugins/__tests__/doc-tree.property.test.ts
apps/docs/src/plugins/__tests__/tree-union.property.test.ts
apps/studio/src/modules/settings/__tests__/ai-approvals-card.property.test.ts
packages/database/src/__tests__/revision-provenance.property.test.ts
```

#396 còn đụng 2 file nữa (`link-rewriter.property.test.ts`, `toc-heading-extraction.property.test.ts`) — đó là các thay đổi khác của v4 (suy luận readonly tuple), giữ lại khi rebase.

**`fc.date()` — bug thật, không phải regression v4.** `noInvalidDate` mặc định false, nên **date arbitrary có bound vẫn sinh được `Invalid Date`**. Bias sinh khác của v4 làm nó nổ: property so sánh thứ tự approvals so NaN timestamp, và card arbitrary của Studio sẽ throw ở `new Date(NaN).toISOString()`. Sửa = `noInvalidDate: true`. Việc này đúng ra phải sửa từ v3; v4 chỉ là thứ phát hiện ra.

`fast-check` được nâng ở **cả 4** package cùng lúc (`apps/cms`, `apps/docs`, `apps/studio`, `packages/database` — tất cả đang `^3.22.0`). Hai major cùng một test library trong một monorepo là drift chỉ đắt thêm theo thời gian (Req 6.6).

#### `@dnd-kit/sortable` 8 → 10

Peer của sortable 10 là `@dnd-kit/core: ^6.3.0`. `apps/studio` khai `^6.1.0`, lockfile đã resolve **6.3.1** → peer thoả **tình cờ**. Nâng range khai báo lên `^6.3.0` để nó thoả *theo thiết kế*; nếu không, một lần dedupe hay một resolution khác kéo core về 6.1.x là vỡ peer mà manifest vẫn trông hợp lệ.

3 file consumer, cùng một pattern (`SortableContext` + `useSortable` + `CSS.Transform`):
`apps/studio/src/modules/data-model/fields-tab.tsx` · `.../content/interfaces/relation-m2a.tsx` · `.../content/interfaces/relation-many.tsx`

#### `uuid` 11 → 14

Đúng **một** import site trong toàn repo: `apps/cms/src/modules/audit/worker.ts` — `import { v7 as uuidv7 } from 'uuid'`. Phần còn lại của codebase dùng nanoid theo convention (`packages/database/src/schema/regulated.ts` ghi rõ "deliberately carries no uuidv7 dependency").

`v7` vẫn export ở 14. Thay đổi thật là **export map**: 12.x thêm nhánh `browser`, 13.x/14.x thêm nhánh `node` trả `dist-node`. Rủi ro nằm ở resolution của bundler Worker, không ở API — nên verify phải gồm **build Worker thật**, không chỉ typecheck (Req 6.10).

#### `@testing-library/jest-dom` 6 → 7

Peer `@testing-library/dom >=10 <11`, đang resolve 10.4.1 ✓. `@testing-library/react ^16.0.1` không đổi. Không cần sửa source — chỉ verify.

## Correctness Properties

Các bất biến batch phải giữ. Mỗi cái có cách kiểm cơ giới, không dựa vào review nhớ.

### Property 1: Override không được đè manifest

Với mọi entry trong `overrides` và mọi workspace package khai trực tiếp cùng package đó, range override PHẢI giao với range khai báo. Kiểm bằng `pnpm check:override-drift`. Ca vi phạm hiện có trên `main`: `vite` override `^7.3.5` vs `apps/{studio,docs}` khai `^8.1.3`.

**Validates: Requirements 4.1, 4.4**

### Property 2: Hai bản khai install settings phải trùng nhau

`overrides`, `patchedDependencies`, `auditConfig` trong `package.json` (pnpm 9 đọc) PHẢI giống bản trong `pnpm-workspace.yaml` (pnpm 10+ đọc). Kiểm bằng `pnpm settings:check` (#397 đã thêm).

**Validates: Requirements 3.3, 3.4**

### Property 3: Version thật phải khớp manifest

Version trong lockfile importer PHẢI thoả range manifest khai báo, không chỉ thoả range override. Kiểm bằng cách đọc importer của `apps/studio` và `apps/docs` trong `pnpm-lock.yaml`. Đây là mặt sau của Property 1 — P1 chặn trước lúc install, cái này xác nhận sau lúc install. Ca `vite` vi phạm cả hai và không gate nào hiện có bắt được.

**Validates: Requirements 7.1, 7.2**

### Property 4: Không advisory high nào sống trong prod tree

`pnpm audit --prod --audit-level high` PHẢI exit 0, và mọi entry `ignoreGhsas` PHẢI có dòng tương ứng trong "Audit ignore registry" của `docs/en/security/dependency-overrides.md`.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 5: Sàn Node phải thoả toolchain đang cài

`engines.node` PHẢI là tập con của giao các `engines.node` mà toolchain yêu cầu — hiện là `vite@8` (`^20.19.0 || >=22.12.0`) và `eslint@10` (`^20.19.0 || ^22.13.0 || >=24`).

**Validates: Requirements 5.1, 5.2**

### Property 6: Mỗi test library chỉ một major trong workspace

Mọi manifest PHẢI khai cùng một major cho `fast-check`. Kiểm bằng grep trên toàn bộ manifest → phải ra một range duy nhất.

**Validates: Requirements 6.6**

### Property 7: Contract shell không đổi qua cú flip vite

Output build Studio PHẢI vẫn ở `apps/studio/dist` và dev server PHẢI vẫn bind 2026, vì `apps/shell/src-tauri/tauri.conf.json` (`frontendDist`, `devUrl`) phụ thuộc cả hai (DoD §2d contract C3/C4).

**Validates: Requirements 7.3, 7.4**

## Testing Strategy

### Toolchain_Flip: verify là đã có hiệu lực

Vì đây chính là chỗ `main` đang sai, verify không được đọc manifest.

**Vite 8:**

1. Nâng `overrides.vite` lên `^8.2.0` cùng lúc với manifest. Không nâng override = flip không xảy ra.
2. Sau `pnpm install`, đọc **lockfile importer** của `apps/studio` và `apps/docs`, khẳng định `version:` là 8.x. Đây là bằng chứng, manifest không phải.
3. Guard §4 xanh → không còn drift.
4. Build thật `apps/studio` + `apps/docs`; khẳng định output vẫn ở `apps/studio/dist` — `apps/shell/src-tauri/tauri.conf.json` (`frontendDist`) phụ thuộc đường dẫn này (DoD §2d contract C3).
5. Dev server Studio vẫn bind 2026 (`devUrl`, contract C4).

**ESLint 10:** thống nhất một major. `apps/consumer` đã khai `^10`, `apps/landing` còn `^9.36.0` → nâng landing lên `^10`, kèm `eslint-config-next` 16.3.1 tương ứng.

### Kế hoạch verify

Thứ tự này để cái rẻ và hay fail nhất chạy trước:

```
pnpm install                    # lockfile mới
pnpm settings:check             # hai bản khai override khớp
pnpm check:override-drift       # guard mới — phải xanh
pnpm version:check
pnpm registry:check
pnpm turbo run typecheck        # recursive, toàn workspace
pnpm turbo run lint
pnpm turbo run test
pnpm build                      # gồm vite 8 (docs/studio) + Next 16.3.1
pnpm audit --prod --audit-level high
```

Lưu ý khi chạy:

- `pnpm test` full suite **reset setup state** qua DB integration test (`AGENTS.md`). Chạy trên DB scratch, không dùng DB local đang có dữ liệu.
- Test `apps/studio/.../goals-actions.test.tsx` là **flake đã biết** (backlog B13, timeout ở `findByRole` khi chạy full suite trên Node 24). Nếu nó đỏ, xác nhận flake bằng cách chạy riêng file đó trước khi kết luận batch gây regression.
- `pnpm audit` còn advisory dev-only transitive nằm ngoài `--prod`; ghi số lượng, không chặn batch (Req 2.5).
- Verify Worker build cho `uuid` (§6.5) không nằm trong `pnpm build` mặc định của cms — cần build target production tường minh.

## Error Handling

Batch không thêm error path lúc runtime — nó chỉ thêm failure mode lúc build/CI. Từng cái phải fail **ồn ào**, vì cả lớp lỗi này đặc trưng ở chỗ nó fail im lặng.

| Failure mode | Hành vi mong muốn |
|---|---|
| Override đè manifest (Override_Drift) | `check-override-drift` exit khác 0, in tên package + range override + range manifest + package nào khai. Xem mẫu output dưới. |
| Hai bản khai override lệch nhau | `settings:check` exit khác 0 (đã có từ #397) |
| Advisory `high` còn trong prod tree | Advisory_Gate exit khác 0. **Không** được xử lý bằng cách thêm `ignoreGhsas` |
| Node quá cũ cho toolchain | pnpm chặn ở `engines.node`; `.nvmrc` dẫn contributor về bản đúng trước khi tới đó |
| `fc.date()` sinh `Invalid Date` | Không im lặng so NaN nữa: `noInvalidDate: true` làm arbitrary không sinh được giá trị đó, thay vì để property so sánh NaN và pass giả |
| Peer `@dnd-kit` vỡ sau dedupe | Range khai báo `^6.3.0` làm pnpm báo peer mismatch, thay vì thoả tình cờ rồi vỡ lúc runtime |

Mẫu output của guard — phải nói đủ để sửa mà không cần mở lockfile:

```
Override drift: vite
  override        ^7.3.5   (package.json → pnpm.overrides)
  declared        ^8.1.3   apps/studio (devDependencies)
  declared        ^8.1.3   apps/docs   (devDependencies)
  Ranges do not intersect — the override silently wins and the installed
  version is NOT what these manifests declare.
  Fix: raise the override, or lower the manifests. Do not leave them apart.
```

## Rollback

| Bước | Thu hồi |
|---|---|
| (1) merge #397 | revert commit merge; override quay về giá trị `main`, `settings:check` mất theo — không mất dữ liệu |
| (2) rebase + force-push #396' | SHA cũ còn trong reflog và trong `origin/chore/deps-consolidated-upgrade` trước khi force; ghi lại SHA trước khi push |
| (3) merge #396' | revert; đây là thay đổi dependency + source, không có migration DB, không có thay đổi schema → rollback không cần bước dữ liệu |
| Node_Floor | revert cùng (3); chỉ là metadata manifest |

Batch **không** chứa migration nào, nên không có bước dữ liệu ở bất kỳ hướng nào.

## DoD

| Mục | Xử lý |
|---|---|
| §2 setup impact | Thêm một dòng Registry. Không seed / settings key / policy / wizard step / capability / migration → dòng `n/a` kèm ngày rà soát. Số thứ tự lấy bằng `pnpm registry:check`, không bốc "số kế tiếp". |
| §2b multi-tenant | Không đụng đường dữ liệu, cache key, queue key, hay realtime fan-out. Không có `siteId` nào bị ảnh hưởng. |
| §2c route guard | Không thêm/đổi route hay middleware. |
| §2d shell | C3 + C4 **trong phạm vi** vì Studio đổi vite major → verify trên build thật (§7). C1/C2/C6/C7 không đụng. |
| §4 docs | Cập nhật bảng "Overrides registry" ở `docs/{en,vi}/security/dependency-overrides.md`. CHANGELOG nêu các major + Node_Floor mới (yêu cầu môi trường mới cho contributor). |
| §5 tutorial | Không đổi contract nào tutorial dựa vào (endpoint, response shape, header, SDK signature, env var, CLI). Không đụng tutorial. |
| §6 DoD evolution | Override_Drift là **class lỗi mới**, chưa mục DoD nào phủ. Hàng rào là cơ giới (guard §4) chứ không phải checklist. Thêm một dòng vào DoD kèm blockquote nêu ca `vite`. |
| §7 out-of-scope | Cập nhật B15 (Settings_Parity đã xong → pnpm 10 bump giờ an toàn) và B14 (`graphql@17` ↔ yoga peer **vẫn còn** sau batch; #399 bump yoga lên 5.21.3 không đóng nó). Log mọi phát hiện mới trong cùng PR. |

## Quyết định còn mở

1. **Merge #397 riêng, hay stack #396 lên thẳng nhánh #397?** Thiết kế trên chọn merge riêng — #397 nhỏ, tự đứng được, và đáng có review riêng vì nó đổi cách repo đọc install settings. Stack lại thì ít một vòng CI nhưng gộp hai loại rủi ro vào một review.
2. **`.nvmrc` = 24 hay 22.13?** Thiết kế chọn 24 để khớp CI. Chọn 22.13 thì local giống sàn tối thiểu hơn, nhưng lại khác CI — và khác CI là class "xanh ở máy, đỏ ở CI".
3. **`semver` làm devDependency root cho guard.** Thay thế là tự parse range, tôi không đề xuất: có 4 dạng range trong bảng §3.2, tự parse là mời bug vào đúng cái guard chống bug.
