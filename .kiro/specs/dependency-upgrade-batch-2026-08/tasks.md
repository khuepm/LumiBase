# Implementation Plan: Dependency Upgrade Batch (2026-08)

> Điều kiện hoàn thành: `pnpm settings:check` · `pnpm check:override-drift` · `pnpm version:check` · `pnpm registry:check` · `pnpm turbo run typecheck` (recursive) · `pnpm turbo run test` · `pnpm turbo run lint` · `pnpm build` · `pnpm audit --prod --audit-level high` — tất cả xanh, cộng rà Setup Impact Registry theo Definition of Done.
>
> **Ba việc cần người**, không tự chạy: merge #397 (task 1.1), force-push #396' (task 8.1), đóng PR (task 9). Mọi task khác cục bộ và revert được.

## Overview

Gộp 13 PR Dependabot + 4 PR consolidation chồng lấn thành hai lần merge có thứ tự, cộng hai việc không PR nào có: nâng Node_Floor và guard chống Override_Drift. Chi tiết cơ chế ở `design.md`.

Ba nhóm công việc, ranh giới rõ:

- **Cần người** — merge #397 (1.1), force-push #396' (8.1), đóng PR (9). Ghi vào branch dùng chung hoặc lộ ra ngoài.
- **Cục bộ, revert được** — 2–7, 10–12. Rebase, sửa source, viết guard, chạy gate.
- **Chờ CI thật** — 8.3, 8.4. Không tự quyết được kết quả.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": [
        "1"
      ],
      "description": "Merge #397 vào main làm base — cần người"
    },
    {
      "wave": 2,
      "tasks": [
        "2"
      ],
      "description": "Rebase #396 lên main, giải quyết 2 hunk conflict"
    },
    {
      "wave": 3,
      "tasks": [
        "3",
        "4",
        "5"
      ],
      "description": "Song song: đồng bộ pnpm-workspace.yaml, hấp thu số #399, nâng Node_Floor + eslint 10"
    },
    {
      "wave": 4,
      "tasks": [
        "6"
      ],
      "description": "pnpm install, verify Toolchain_Flip qua lockfile importer"
    },
    {
      "wave": 5,
      "tasks": [
        "7"
      ],
      "description": "Guard chống Override_Drift + test guard"
    },
    {
      "wave": 6,
      "tasks": [
        "10"
      ],
      "description": "Verify source migration của các Breaking_Major"
    },
    {
      "wave": 7,
      "tasks": [
        "11"
      ],
      "description": "Chạy toàn bộ quality gate cục bộ"
    },
    {
      "wave": 8,
      "tasks": [
        "12"
      ],
      "description": "DoD: registry, docs, CHANGELOG, backlog"
    },
    {
      "wave": 9,
      "tasks": [
        "8"
      ],
      "description": "Force-push #396', chờ CI, merge — cần người"
    },
    {
      "wave": 10,
      "tasks": [
        "9"
      ],
      "description": "Đóng PR bị vượt/hấp thu, xử lý #398 — cần người"
    }
  ]
}
```

```
1 (merge #397)
└─→ 2 (rebase)
     ├─→ 3 (sync pnpm-workspace.yaml)   ─┐
     ├─→ 4 (hấp thu số #399)            ─┤
     └─→ 5 (Node_Floor + eslint 10)     ─┤
                                          ├─→ 6 (pnpm install + verify flip)
                                          │      └─→ 7 (guard drift)
                                          │            └─→ 10 (verify source migration)
                                          │                  └─→ 11 (toàn bộ gate)
                                          │                        └─→ 12 (DoD)
                                          │                              └─→ 8 (push + merge)
                                          │                                    └─→ 9 (dọn PR)
                                          └─ 3,4,5 độc lập nhau, làm song song được
```

Ràng buộc không thể đảo:

- **1 → 2**: cả #396 và #397 sửa `pnpm.overrides`; dạng scoped của #397 là base đúng.
- **3 → 6**: `settings:check` đỏ nếu install trước khi đồng bộ hai bản khai.
- **6 → 7**: guard đọc lockfile-adjacent state; chạy trước install là đo cây cũ.
- **11 → 8**: không push khi gate cục bộ chưa xanh — mỗi vòng CI của batch này rất dài.
- **8.4 → 9.3**: chỉ đóng #369–#381 sau khi #396' merge **thật**, không đóng trước.

## Tasks

- [x] 1. Đưa #397 vào `main` làm base
  - [x] 1.1 Merge PR #397 (`claude/cache-stack-8-layers-n6ggtk`) — advisory + Settings_Parity + gate `settings:check` (Req 1.1)
  - [x] 1.2 Fetch `main` mới, xác nhận `scripts/check-pnpm-settings-parity.mjs` và `pnpm-workspace.yaml` đã có mặt (Req 3.3, 3.4)
  - [x] 1.3 Ghi lại SHA hiện tại của `origin/chore/deps-consolidated-upgrade` trước khi rebase, để rollback được (Design §Rollback)

- [x] 2. Rebase #396 lên `main`
  - [x] 2.1 `git rebase origin/main` trên nhánh `chore/deps-consolidated-upgrade` — dự kiến conflict ở đúng 2 file: `package.json`, `pnpm-lock.yaml` (Req 1.2)
  - [x] 2.2 Giải quyết hunk 1 `@types/react`/`@types/react-dom`: lấy `19.2.18`/`19.2.4` của #396 (Req 3.1, Design §Data Models)
  - [x] 2.3 Giải quyết hunk 2 `nanoid`: giữ dạng scoped `nanoid@3`/`nanoid@5` của #397, **bỏ** dạng phẳng của #396 (Req 3.1, 3.2)
  - [x] 2.4 Lockfile: KHÔNG merge tay — `git checkout --ours` rồi regenerate bằng `pnpm install` ở task 6

- [x] 3. Đồng bộ `pnpm-workspace.yaml` — việc không PR nào có
  - [x] 3.1 Cập nhật khối `overrides` trong `pnpm-workspace.yaml` khớp đúng bảng §Data Models của design (15 entry) (Req 3.3)
  - [x] 3.2 Xác nhận `patchedDependencies` + `auditConfig` vẫn khớp hai chỗ (Req 3.3)
  - [x] 3.3 `pnpm settings:check` xanh — đây là gate #397 vừa thêm, và nó sẽ đỏ nếu bỏ qua task này (Design §Overview)

- [x] 4. Hấp thu số của #399
  - [x] 4.1 Nâng 10 package theo bảng §Architecture: `turbo` 2.10.9 · `wrangler` 4.123.0 · `next` + `eslint-config-next` 16.3.1 · `@shikijs/rehype` 4.4.3 · `@hookform/resolvers` 5.8.0 · `react-hook-form` 7.85.0 · `@aws-sdk/client-s3` 3.1110.0 · `ws` ^8.21.3 · `postcss` ^8.5.26 · `esbuild` ^0.28.2 (Req 1.5)
  - [x] 4.2 Các entry nào của nhóm này cũng nằm trong `overrides` (`ws`, `postcss`, `esbuild`) phải nâng ở **cả** manifest và hai bản khai override (Req 3.3, Property 1)

- [x] 5. Nâng Node_Floor
  - [x] 5.1 `engines.node` root: `>=22` → `>=22.13.0` (sàn thấp nhất thoả cả vite 8 và eslint 10) (Req 5.1, 5.2)
  - [x] 5.2 `.nvmrc`: `22` → `24`, khớp `NODE_VERSION` trong `ci.yml` (Req 5.3, 5.4)
  - [x] 5.3 `packages/mcp-server` giữ `engines.node: ">=18"` — thêm comment/ghi chú nêu đây là contract với consumer của package published, không phải sàn toolchain (Req 5.6)
  - [x] 5.4 Thống nhất ESLint: `apps/landing` `^9.36.0` → `^10`, `eslint-config-next` theo 16.3.1 (Req 7.5)

- [x] 6. Regenerate lockfile và verify Toolchain_Flip
  - [x] 6.1 `pnpm install` — lockfile mới, hoàn tất task 2.4
  - [x] 6.2 Đọc **lockfile importer** của `apps/studio` + `apps/docs`, khẳng định `vite` resolve 8.x (không đọc manifest) (Req 7.2, Property 3)
  - [x] 6.3 Khẳng định `nanoid` resolve hai nhánh: 3.x cho `postcss`, 5.x cho `apps/cms`/`packages/database` (Req 2.2, 3.1)

- [x] 7. Guard chống Override_Drift
  - [x] 7.1 Thêm `semver` làm devDependency root, pin exact (Design §Quyết định còn mở #3)
  - [x] 7.2 Viết `scripts/check-override-drift.mjs` theo thuật toán 5 bước ở §Components and Interfaces — tách scope `pkg@range`, đọc workspace theo `pnpm-workspace.yaml` (loại `!apps/marketplace`), so bằng `semver.intersects()` (Req 4.1, 4.5)
  - [x] 7.3 Thông báo lỗi nêu tên package + range override + range manifest + package nào khai (Req 4.3, §Error Handling)
  - [x] 7.4 Thêm script `check:override-drift` vào root `package.json` + bước CI cạnh `settings:check`/`registry:check` (Req 4.2)
  - [x] 7.5 Test guard với 5 fixture ở §Components and Interfaces — bao gồm ca `vite` thật (fail) và ca scoped `nanoid@3` (pass) (Req 4.4, Property 1)
  - [x] 7.6 Chạy guard trên cây hiện tại — phải xanh sau task 2–6, và phải **đỏ** nếu tạm hạ `overrides.vite` về `^7.3.5` (chứng minh nó bắt được ca thật)

- [ ] 8. Đẩy #396' và merge
  - [ ] 8.1 Force-push nhánh `chore/deps-consolidated-upgrade` (cần cho phép — rewrite history nhánh đã push) (Req 1.2)
  - [ ] 8.2 Cập nhật mô tả PR #396: nêu việc hấp thu #399, đồng bộ `pnpm-workspace.yaml`, Node_Floor, guard drift, và ca drift `vite` phát hiện trên `main`
  - [ ] 8.3 Chờ CI xanh toàn bộ, gồm `e2e-golden-path` (Req 10.4)
  - [ ] 8.4 Merge #396'

- [ ] 9. Dọn PR
  - [ ] 9.1 Đóng #382 (trùng #396) và #383 (đã bị #385 trên `main` vượt) (Req 1.4)
  - [ ] 9.2 **KHÔNG đóng #399** — chỉ 10/26 package của nó chồng lấn và đã hấp thu; `hono`, `@types/node`, `graphql-yoga` và phần còn lại thì chưa. Sau khi #396' merge, comment `@dependabot rebase` để nó tự dựng lại trên lockfile mới rồi merge (Req 1.5)
  - [ ] 9.3 Sau khi #396' merge: đóng #369, #371, #373, #374, #375, #376, #377, #378, #379, #380, #381 kèm comment trỏ #396' (Req 1.3)
  - [ ] 9.4 Xử lý #398 (`codeql-action/upload-sarif` 4.36.2 → 4.37.7) độc lập — xác nhận workflow CodeQL vẫn chạy (Req 8.3)
  - [ ] 9.5 Rà `actions/upload-artifact` 4 → 7 của #369: nếu #396' không mang nó thì kiểm mọi call site trong `.github/workflows/` cho thay đổi API qua major (Req 8.2)

- [x] 10. Verify source migration của các Breaking_Major (đã có trong #396, xác nhận còn nguyên sau rebase)
  - [x] 10.1 `@cloudflare/workers-types` 5: 3 call site Buffer đã chuyển Web-standard (`ArrayBuffer.isView`, `TextDecoder`, `btoa`), không có `@types/node` nào bị thêm vào `types` của Worker build (Req 6.1)
  - [x] 10.2 `ExecutionContext` nới rộng: helper tự infer return type, không `as any`, không cast (Req 6.2)
  - [x] 10.3 `lucide-react` 1.x: `Github` ở `apps/landing/src/components/Header.tsx` đã thành inline SVG, giữ `className="h-4 w-4"`; enumerate lại toàn bộ call site lucide để xác nhận không còn export bị xoá nào (Req 6.3, 6.4)
  - [x] 10.4 `fast-check` 4: 13 file đã migrate `stringOf`/`hexaString`/`char`; nâng ở cả 4 package, không còn manifest nào ở `^3.22.0` (Req 6.5, 6.6, Property 6)
  - [x] 10.5 Mọi `fc.date()` có `noInvalidDate: true` (Req 6.7)
  - [x] 10.6 `@dnd-kit/core` nâng range khai báo lên `^6.3.0` cho khớp peer của sortable 10 — #396 chưa làm việc này (Req 6.8)
  - [x] 10.7 `uuid` 14: verify 1 import site + **build Worker production thật**, không chỉ typecheck (Req 6.10)
  - [x] 10.8 `jest-dom` 7: xác nhận `@testing-library/dom` resolve trong `>=10 <11` (Req 6.11)

- [x] 11. Verify toàn bộ gate
  - [x] 11.1 `pnpm settings:check` · `pnpm check:override-drift` · `pnpm version:check` · `pnpm registry:check` (Req 10.3)
  - [x] 11.2 `pnpm turbo run typecheck` recursive toàn workspace (Req 10.1)
  - [x] 11.3 `pnpm turbo run lint` · `pnpm turbo run test` — DB integration test **reset setup state**, chạy trên DB scratch (Req 10.2, Design §Testing Strategy)
  - [x] 11.4 `pnpm build` gồm vite 8 (docs/studio) + Next 16.3.1 (landing/consumer) (Req 10.2)
  - [x] 11.5 Build Studio: output vẫn ở `apps/studio/dist`, dev server vẫn bind 2026 (DoD §2d C3/C4) (Req 7.3, 7.4, Property 7)
  - [x] 11.6 `pnpm audit --prod --audit-level high` exit 0; ghi số advisory dev-only còn lại (Req 2.1, 2.5)
  - [x] 11.7 Nếu `goals-actions.test.tsx` đỏ: chạy riêng file để xác nhận flake B13 trước khi kết luận regression (Design §Testing Strategy)

- [x] 12. DoD
  - [x] 12.1 Thêm dòng Setup Impact Registry — `n/a` kèm ngày rà soát; số thứ tự lấy qua `pnpm registry:check`, không bốc "số kế tiếp" (Req 10.5)
  - [x] 12.2 Cập nhật bảng "Overrides registry" ở `docs/en/security/dependency-overrides.md` + mirror `docs/vi/` cho mọi entry đổi giá trị (Req 3.5)
  - [x] 12.3 CHANGELOG: các major đã lấy + Node_Floor mới, nêu rõ đây là yêu cầu môi trường mới cho contributor (Req 10.6)
  - [x] 12.4 Thêm hàng rào Override_Drift vào `definition-of-done.md` kèm blockquote nêu ca `vite` (DoD §6) (Req 10.8)
  - [x] 12.5 Cập nhật `out-of-scope-backlog.md`: B15 → Settings_Parity xong, bump pnpm 10 giờ an toàn; B14 → peer `graphql@17` ↔ yoga **vẫn còn** sau batch, yoga hiện 5.21.3 (Req 9.2, 9.3)
  - [x] 12.6 Log mọi phát hiện ngoài scope mới vào `out-of-scope-backlog.md` trong cùng PR (Req 9.4)

---

**Implementation status:** Not started. Spec viết 2026-08-20 sau khảo sát trực tiếp `main` tại `b8c5137c` (v0.25.0) + một lần rebase khô đã dọn.

## Notes

- **`pnpm test` reset setup state** qua DB integration test (`AGENTS.md`). Dùng DB scratch, đừng chạy lên DB local đang có dữ liệu.
- **`goals-actions.test.tsx` là flake đã biết** (B13): timeout ở `findByRole` khi chạy full suite trên Node 24. Đỏ ở đây thì chạy riêng file trước khi kết luận batch gây regression.
- **Guard phải được chứng minh, không chỉ chạy xanh** (7.6). Một guard luôn-xanh không phân biệt được với guard không hoạt động.
- **Verify Toolchain_Flip đọc lockfile, không đọc manifest** (6.2). Đây chính là chỗ `main` đang sai: manifest ghi vite 8, thực cài 7.3.6.
- **`uuid` 14 cần build Worker thật** (10.7). Thay đổi là export map, không phải API — typecheck không bắt được.
- **Ghi SHA trước khi force-push** (1.3). Đó là đường về duy nhất nếu #396' sai.
