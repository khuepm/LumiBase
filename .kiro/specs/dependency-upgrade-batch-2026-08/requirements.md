# Requirements Document

**Feature:** Dependency Upgrade Batch (2026-08)

## Introduction

Repo đang có **13 PR Dependabot mở** (#369, #371, #373, #374, #375, #376, #377, #378, #379, #380, #381, #398, #399) và **4 PR consolidation do người viết** chồng lấn lên chúng (#382, #383, #396, #397). Hai trong bốn PR đó — #396 và #397 — đều ở trạng thái `CLEAN`/`MERGEABLE` và **đều sửa `pnpm.overrides` ở root**, nên merge cái này sẽ làm bẩn cái kia. Xung đột không chỉ ở mức text: #396 dùng override phẳng `nanoid: ^5.1.16`, #397 dùng dạng scoped `nanoid@3` / `nanoid@5`. Bản phẳng sẽ kéo `next → postcss → nanoid@3` lên 5.x và làm vỡ postcss.

Khảo sát trực tiếp trên `main` (tại `b8c5137c`, v0.25.0) còn phát hiện một **drift không được ghi trong PR nào**: `pnpm.overrides.vite: ^7.3.5` đè lên direct devDependency của `apps/studio` và `apps/docs` (cả hai khai `^8.1.3`). Lockfile importer xác nhận `specifier: ^7.3.5 → 7.3.6`, nghĩa là hai app đang build bằng **Vite 7** dù manifest ghi 8. Đây là class lỗi "override âm thầm đè manifest" mà `docs/en/security/dependency-overrides.md` tồn tại để chống, nhưng hiện không có hàng rào cơ giới nào phát hiện.

Spec này quyết định **thứ tự merge**, **phạm vi sửa source cho từng major có breaking change**, **sàn Node**, và **hàng rào chống drift tái diễn**. Mục tiêu là đưa toàn bộ dependency lên bản đã vá advisory mà không để lại trạng thái mập mờ nào giữa manifest, override, và lockfile.

Spec này KHÔNG bao gồm việc bump `packageManager` lên pnpm 10 (chỉ chuẩn bị điều kiện — xem Req 3) và KHÔNG giải quyết vi phạm peer `graphql@17` ↔ `graphql-yoga@5` (backlog B14 — xem Req 9).

## Glossary

- **Consolidated_PR**: Một PR duy nhất mang toàn bộ bump + source migration đi kèm, thay cho việc merge tuần tự từng PR Dependabot (merge tuần tự bất khả thi vì mỗi lần merge làm lockfile của PR kế tiếp mất giá trị).
- **Advisory_Gate**: Job `Dependency vulnerability audit` trong `.github/workflows/ci.yml`, chạy `pnpm audit --prod --audit-level high`.
- **Settings_Parity**: Trạng thái ba key `overrides` / `patchedDependencies` / `auditConfig` được khai **song song** ở root `package.json` (pnpm 9 đọc) và `pnpm-workspace.yaml` (pnpm 10+ đọc), không lệch nhau.
- **Override_Drift**: Trạng thái một package được khai ở manifest của workspace package với range X, nhưng `pnpm.overrides` buộc nó về range Y ⊅ X, khiến bản thực cài khác bản manifest tuyên bố.
- **Scoped_Override**: Override giới hạn theo major range (`nanoid@3`, `nanoid@5`), đối lập với **Flat_Override** (`nanoid`) áp cho mọi range.
- **Node_Floor**: Phiên bản Node thấp nhất mà repo tuyên bố hỗ trợ, khai ở `engines.node` (root `package.json`) và `.nvmrc`.
- **Toolchain_Flip**: Lần đổi thật sự có hiệu lực của build tool (Vite 7→8, ESLint 9→10), phân biệt với việc chỉ đổi số trong manifest mà override vẫn giữ bản cũ.
- **Breaking_Major**: Bump major có yêu cầu sửa source trong repo này, đã xác nhận bằng cách đọc code trên `main`.

## Requirements

### Requirement 1: Thứ tự merge và dọn PR trùng

**User Story:** Là maintainer, tôi muốn 17 PR dependency mở được rút về một đường đi có thứ tự xác định, để không có lần merge nào làm mất hiệu lực công việc của lần merge khác.

#### Acceptance Criteria

1. THE plan SHALL merge #397 **trước** #396, vì #397 nhỏ hơn, chỉ chứa advisory + Settings_Parity, và Settings_Parity là tiền đề cho mọi lần bump pnpm về sau (backlog B15).
2. WHEN #397 đã vào `main`, THE Consolidated_PR (#396) SHALL được rebase lên `main` và cài lại lockfile, KHÔNG merge `main` vào nhánh để tránh lockfile hợp nhất nửa vời.
3. THE Consolidated_PR SHALL là PR duy nhất mang các Breaking_Major; các PR Dependabot #369–#381 SHALL được đóng với comment trỏ tới Consolidated_PR sau khi nó merge.
4. THE plan SHALL đóng #382 (`claude/pr-dependencies-41emwy`) là trùng lặp với #396, và đóng #383 (`fix/dependabot-alerts-2026-07`) là đã bị `main` vượt qua — `fast-uri: >=4.1.2` đã có trên `main` từ #385.
5. WHEN mọi PR trên đã xử lý, THE plan SHALL xử lý #398 và #399 độc lập, vì cả hai chỉ chứa bump minor/patch và bump GitHub Actions (xem Req 8).
6. THE plan SHALL KHÔNG merge #396 và #397 song song vào cùng một base, vì cả hai sửa `pnpm.overrides` ở root `package.json`.

### Requirement 2: Đóng advisory và giữ Advisory_Gate xanh

**User Story:** Là người vận hành, tôi muốn mọi advisory high trong prod tree được đóng bằng version đã vá, không bằng cách nới gate.

#### Acceptance Criteria

1. WHEN toàn bộ batch đã merge, THE Advisory_Gate SHALL exit 0 trên `main`.
2. THE batch SHALL đóng các advisory sau bằng version đã vá, KHÔNG bằng `auditConfig.ignoreGhsas`:
   - `GHSA-28wg-ghj8-5hjv` (`nanoid` 5.x, high) → `^5.1.16`
   - `GHSA-2v37-7h3g-55p8` (`nanoid` 3.x, high, tới qua `next → postcss`) → `^3.3.17`
   - `GHSA-5p4m-2wfm-xmqj` và `GHSA-mxjm-jjmh-r63x` (`js-yaml`, high) → `^4.3.1`
   - `GHSA-8v5p-ggcr-6q56` (`dompurify`, moderate) → `^3.4.13`
3. IF một advisory không thể đóng bằng version đã vá, THEN nó SHALL được thêm vào `auditConfig.ignoreGhsas` **kèm một dòng trong "Audit ignore registry"** của `docs/en/security/dependency-overrides.md` nêu lý do cấu trúc + điều kiện revisit; entry không có dòng registry SHALL bị coi là không hợp lệ.
4. THE batch SHALL KHÔNG thêm advisory ignore nào chỉ để làm CI xanh.
5. THE advisory chỉ nằm trong dev-only transitive dep SHALL được ghi lại (số lượng + tên) nhưng KHÔNG chặn batch, vì Advisory_Gate chỉ gate phạm vi `--prod`.

### Requirement 3: Hoà giải override và giữ Settings_Parity

**User Story:** Là maintainer, tôi muốn `pnpm.overrides` sau batch không tự mâu thuẫn, và không biến mất im lặng khi repo lên pnpm 10.

#### Acceptance Criteria

1. THE override cho `nanoid` SHALL dùng dạng Scoped_Override (`nanoid@3: ^3.3.17` và `nanoid@5: ^5.1.16`), KHÔNG dùng Flat_Override, vì Flat_Override sẽ kéo `next → postcss → nanoid@3` lên 5.x và làm vỡ postcss.
2. WHEN Consolidated_PR được rebase lên `main` đã có #397, THE việc hoà giải SHALL giữ dạng Scoped_Override của #397 và loại bỏ Flat_Override của #396.
3. THE ba key `overrides`, `patchedDependencies`, `auditConfig` SHALL đạt Settings_Parity giữa root `package.json` và `pnpm-workspace.yaml` sau batch.
4. THE Settings_Parity SHALL được kiểm bằng một script chạy trong CI (`pnpm settings:check`), fail khi hai bản khai lệch nhau — không dựa vào người review nhớ sửa cả hai chỗ.
5. THE mọi thay đổi override trong batch SHALL được phản ánh vào bảng "Overrides registry" của `docs/en/security/dependency-overrides.md` **và** bản mirror `docs/vi/`, kèm cột "Remove when".
6. THE batch SHALL KHÔNG bump `packageManager` khỏi `pnpm@9.12.0`; nó chỉ tạo điều kiện để lần bump đó an toàn.

### Requirement 4: Hàng rào chống Override_Drift

**User Story:** Là maintainer, tôi muốn không bao giờ lặp lại tình trạng manifest ghi Vite 8 nhưng thực cài Vite 7, để "đã bump" và "đã có hiệu lực" là một.

#### Acceptance Criteria

1. THE batch SHALL thêm một kiểm tra cơ giới phát hiện Override_Drift: với mỗi entry trong `overrides`, nếu có workspace package khai **direct dependency** cùng tên với range KHÔNG giao với range override, kiểm tra SHALL fail.
2. THE kiểm tra SHALL chạy trong CI, cùng nhóm với `pnpm settings:check` và `pnpm registry:check`.
3. WHEN kiểm tra fail, THE thông báo lỗi SHALL nêu tên package, range ở manifest, range ở override, và package nào khai nó — đủ để sửa mà không phải đọc lockfile.
4. THE kiểm tra SHALL phát hiện được đúng ca đã xảy ra trên `main`: `vite` override `^7.3.5` vs `apps/studio` + `apps/docs` khai `^8.1.3`.
5. THE kiểm tra SHALL KHÔNG fail với override chỉ áp cho transitive dep (không workspace package nào khai trực tiếp), vì đó là cách dùng đúng của override bảo mật.

### Requirement 5: Nâng Node_Floor cho toolchain mới

**User Story:** Là contributor, tôi muốn `.nvmrc` và `engines.node` phản ánh Node thật sự cần, để không clone repo về rồi vỡ build vì Node quá cũ.

#### Acceptance Criteria

1. THE Node_Floor SHALL được nâng để thoả đồng thời: `vite@8` (`^20.19.0 || >=22.12.0`) và `eslint@10` (`^20.19.0 || ^22.13.0 || >=24`).
2. THE root `engines.node` SHALL được đổi khỏi `>=22` hiện tại, vì `>=22` cho phép 22.0–22.12 — dải làm vỡ cả vite 8 và eslint 10.
3. THE `.nvmrc` SHALL được đổi khỏi `22` hiện tại sang một phiên bản cụ thể thoả Node_Floor.
4. THE Node_Floor SHALL nhất quán với `NODE_VERSION: 24` đang dùng trong `.github/workflows/ci.yml`; nếu chọn floor khác 24, chênh lệch SHALL được nêu lý do.
5. THE thay đổi Node_Floor SHALL nằm **cùng PR** với Toolchain_Flip của vite 8 / eslint 10, không tách ra PR sau.
6. THE `packages/mcp-server` đang khai `engines.node: ">=18"` SHALL được rà lại: hoặc nâng theo Node_Floor, hoặc ghi rõ vì sao nó được phép giữ sàn thấp hơn (published package, không phụ thuộc toolchain workspace).

### Requirement 6: Sửa source cho từng Breaking_Major

**User Story:** Là maintainer, tôi muốn từng major có breaking change được sửa đúng phạm vi đã xác minh trên code, không sửa thừa và không bỏ sót call site.

#### Acceptance Criteria

1. WHERE `@cloudflare/workers-types` lên 5.x, THE batch SHALL sửa các call site mất Node `Buffer` typings — v5 tự khai `Buffer: any` và nó là `types` entry duy nhất của `apps/cms/tsconfig.json`. Ba call site đã xác định: `packages/runtime/src/adapters/cloudflare/storage.ts`, `apps/cms/src/modules/git-integration/ci-log-store.ts`, `apps/cms/src/services/__tests__/extension-signature.test.ts`.
2. WHERE `@cloudflare/workers-types` lên 5.x, THE batch SHALL xử lý việc global `ExecutionContext` bị nới rộng (thêm `tracing`/`abort` bắt buộc) lệch với shape hẹp hơn của Hono `c.executionCtx`; cách xử lý SHALL giữ giá trị chảy về `subApp.fetch()` đúng shape Hono, KHÔNG dùng `as any`.
3. WHERE `lucide-react` lên 1.x, THE batch SHALL thay `Github` — export bị xoá (brand marks bị bỏ ở 1.x) — tại `apps/landing/src/components/Header.tsx` (import ở dòng 5, render ở 2 chỗ). THE thay thế SHALL giữ nguyên hình dáng mark GitHub (inline SVG), KHÔNG thay bằng glyph generic vì việc đó âm thầm đổi diện mạo link.
4. WHERE `lucide-react` lên 1.x, THE batch SHALL kiểm **toàn bộ** call site lucide (không chỉ file đã biết) để xác nhận `Github` là export bị xoá duy nhất còn dùng, và ghi lại số call site đã kiểm.
5. WHERE `fast-check` lên 4.x, THE batch SHALL migrate các API bị thay: `fc.stringOf(unit, c)` → `fc.string({ unit, ...c })`, `fc.hexaString(c)` → `fc.string({ unit: <hex>, ...c })`, `fc.char()` → charset tường minh. Ít nhất 13 file test đã xác nhận bị ảnh hưởng, trải trên `apps/cms`, `apps/docs`, `apps/studio`, `packages/database`.
6. WHERE `fast-check` lên 4.x, THE batch SHALL nâng fast-check ở **mọi** workspace package cùng lúc (`apps/cms`, `apps/docs`, `apps/studio`, `packages/database` đều đang `^3.22.0`); repo SHALL KHÔNG kết thúc batch với hai major fast-check cùng tồn tại.
7. WHERE `fast-check` lên 4.x, THE mọi `fc.date()` arbitrary SHALL đặt `noInvalidDate: true` — mặc định của nó cho phép sinh `Invalid Date`, và bias sinh khác của v4 làm lỗi tiềm ẩn này nổ ra. Đây là bug thật sẵn có, không phải regression của v4.
8. WHERE `@dnd-kit/sortable` lên 10.x, THE batch SHALL nâng range khai báo của `@dnd-kit/core` lên `^6.3.0` (peer requirement của sortable 10) — hiện `apps/studio` khai `^6.1.0` và peer chỉ thoả *tình cờ* nhờ lockfile đã resolve 6.3.1.
9. WHERE `@dnd-kit/sortable` lên 10.x, THE batch SHALL verify 3 file consumer: `apps/studio/src/modules/data-model/fields-tab.tsx`, `apps/studio/src/modules/content/interfaces/relation-m2a.tsx`, `apps/studio/src/modules/content/interfaces/relation-many.tsx`.
10. WHERE `uuid` lên 14.x, THE batch SHALL verify duy nhất một import site trong repo (`apps/cms/src/modules/audit/worker.ts`, `import { v7 as uuidv7 }`). Rủi ro nằm ở export map (điều kiện `node` giờ trả `dist-node`), KHÔNG ở API — nên verify SHALL bao gồm cả Worker build, không chỉ typecheck.
11. WHERE `@testing-library/jest-dom` lên 7.x, THE batch SHALL xác nhận peer `@testing-library/dom >=10 <11` được thoả (đang resolve 10.4.1) và `@testing-library/react ^16.0.1` không cần đổi.

### Requirement 7: Toolchain_Flip phải được verify là đã có hiệu lực

**User Story:** Là maintainer, tôi muốn bằng chứng Vite 8 và ESLint 10 thật sự đang chạy, chứ không phải chỉ số trong manifest đổi.

#### Acceptance Criteria

1. WHEN batch nâng `vite` lên 8.x, THE `pnpm.overrides.vite` SHALL được nâng đồng thời — nếu không, override cũ giữ lockfile ở Vite 7 và Toolchain_Flip không xảy ra.
2. THE verify cho Vite 8 SHALL đọc **lockfile importer** của `apps/studio` và `apps/docs` để khẳng định `version` đã là 8.x, không chỉ đọc manifest.
3. THE verify cho Vite 8 SHALL bao gồm một build thật của `apps/studio` và `apps/docs`, và khẳng định output vẫn nằm ở đường dẫn cũ (`apps/studio/dist`) vì `apps/shell/src-tauri/tauri.conf.json` phụ thuộc vào nó (DoD §2d, contract C3).
4. THE verify cho Vite 8 SHALL khẳng định dev server của Studio vẫn bind port 2026 (DoD §2d, contract C4).
5. THE ESLint SHALL được thống nhất về một major sau batch — hiện `apps/consumer` khai `^10` trong khi `apps/landing` khai `^9.36.0`.
6. THE batch SHALL KHÔNG kết thúc với bất kỳ Override_Drift mới nào; kiểm tra ở Req 4 SHALL xanh.

### Requirement 8: Bump GitHub Actions

**User Story:** Là maintainer, tôi muốn các bump action được xử lý riêng khỏi bump npm, vì chúng không có lockfile chung và rủi ro khác loại.

#### Acceptance Criteria

1. THE bump action SHALL được xử lý độc lập với Consolidated_PR, vì chúng không đụng `pnpm-lock.yaml`.
2. WHERE `actions/upload-artifact` lên 7 (#369), THE batch SHALL rà mọi call site trong `.github/workflows/` cho các thay đổi API qua major (đặc biệt hành vi khi artifact trùng tên và các input đã bị bỏ).
3. WHERE `github/codeql-action/upload-sarif` lên 4.37.7 (#398) và `ossf/scorecard-action` lên 2.4.4 (#371), THE batch SHALL xác nhận workflow tương ứng vẫn chạy được — CodeQL là một mục BẮT BUỘC trong `v1-release-criteria.md` §3.
4. THE mọi bump action SHALL giữ pin theo tag hoặc SHA nhất quán với cách repo đang pin hiện tại, không đổi kiểu pin trong batch này.

### Requirement 9: Ranh giới phạm vi và mục hoãn

**User Story:** Là maintainer, tôi muốn những gì batch này KHÔNG làm được ghi rõ, để không ai tưởng chúng đã được xử lý.

#### Acceptance Criteria

1. THE batch SHALL KHÔNG giải quyết vi phạm peer `graphql@17` ↔ `graphql-yoga@5` (peer khai `^15 || ^16`) — backlog B14. #399 bump yoga 5.21.2→5.21.3 KHÔNG đóng việc này.
2. WHEN batch merge, THE dòng B14 trong `.kiro/steering/out-of-scope-backlog.md` SHALL được cập nhật để nêu rõ vi phạm vẫn còn sau batch, kèm version yoga hiện tại.
3. THE batch SHALL KHÔNG bump `packageManager` lên pnpm 10; điều kiện cho lần bump đó là Req 3 (Settings_Parity), và B15 SHALL được cập nhật trạng thái tương ứng.
4. THE mọi phát hiện ngoài scope trong lúc làm batch SHALL được log vào `.kiro/steering/out-of-scope-backlog.md` trong **cùng PR** (DoD §7).

### Requirement 10: Quality gate và DoD

**User Story:** Là maintainer, tôi muốn batch này qua đủ gate mà một thay đổi diện rộng cần, vì nó đụng gần như mọi package trong workspace.

#### Acceptance Criteria

1. THE Consolidated_PR SHALL pass `pnpm typecheck` recursive trên toàn workspace, KHÔNG chỉ package lẻ.
2. THE Consolidated_PR SHALL pass `pnpm test` full suite, `pnpm lint`, và `pnpm build`.
3. THE Consolidated_PR SHALL pass `pnpm version:check`, `pnpm registry:check`, `pnpm settings:check`, và kiểm tra Override_Drift ở Req 4.
4. THE Consolidated_PR SHALL pass job `e2e-golden-path` — đây là gate BẮT BUỘC theo `v1-release-criteria.md` §3, và batch đụng runtime dependency của cả hai deployment target.
5. THE Consolidated_PR SHALL thêm một dòng vào bảng Registry của `.kiro/specs/admin-setup-wizard/setup-impact.md`; nếu không có yêu cầu khởi tạo nào, dòng đó SHALL là `n/a` kèm ngày rà soát (DoD §2).
6. THE Consolidated_PR SHALL có entry CHANGELOG nêu các major đã lấy và Node_Floor mới; nếu Node_Floor đổi, entry SHALL nêu đó là yêu cầu môi trường mới cho contributor.
7. THE Consolidated_PR SHALL trả lời câu hỏi DoD §2d (shell contract): C3 và C4 nằm trong phạm vi vì Studio đổi vite major — cả hai SHALL được verify trên build thật, không suy luận.
8. WHERE batch phát hiện một class lỗi mới (ví dụ Override_Drift), THE DoD hoặc steering tương ứng SHALL được cập nhật cùng PR để class đó có hàng rào cơ giới (DoD §6).
