# Nhiệm vụ: dịch docs EN↔VI — LumiBase

**Branch:** `docs/i18n-full-translation` (PR [#205](https://github.com/khuepm/LumiBase/pull/205))
**Mục tiêu:** dịch thủ công 94 file còn lại (+ 1 conflict cần người quyết), gộp vào PR #205
duy nhất. **Không mở PR mới, không đẩy vào `main` trực tiếp.**
**Không dùng `ANTHROPIC_API_KEY`** — mọi bản dịch phải được một LLM đọc và viết tay
(xem "Vì sao thủ công" ở cuối file).

Tài liệu này viết cho **bất kỳ agent/LLM nào** nhận việc tiếp — có thể là một agent
duy nhất chạy tuần tự qua nhiều phiên, hoặc nhiều agent chạy song song mỗi agent
nhận một số file. Đọc kỹ mục "Chạy song song" trước khi bắt đầu nếu bạn không phải
agent duy nhất đang làm việc trên branch này.

---

## 0. Việc đã xong (đừng làm lại)

17 file nhóm A đã dịch, 3 commit trên branch này (`ae842bd7`, `a463330c`, `07042a56`).
Không nằm trong bảng nhiệm vụ dưới đây. Nếu bạn thấy chúng vẫn báo `planned` khi chạy
detect, đó là do bạn chưa `git pull` bản mới nhất của branch — pull trước khi chạy detect.

## 1. Quy trình cho MỖI file (bắt buộc, đã kiểm chứng)

1. **Đọc file nguồn**: `docs/<src>/<rel>` (cột "Nguồn→Đích" trong bảng cho biết `<src>`).
2. **Viết bản dịch** vào `docs/<tgt>/<rel>`. Quy tắc dịch:
   - Giữ nguyên: code block, đường dẫn file, tên biến/hàm, URL, tên lệnh CLI, YAML/JSON key.
   - Dịch: văn xuôi, mô tả, tiêu đề, nội dung bảng (trừ tên cột kỹ thuật).
   - Thuật ngữ kỹ thuật theo quy ước ngành có thể giữ tiếng Anh nếu bản dịch tiếng Việt
     kỹ thuật thường giữ nguyên (ví dụ "headless CMS", "Edge", "runtime", "webhook").
   - Nếu file đích **đã tồn tại** (nhóm B/C) — đây là việc dịch lại/ghi đè, không phải
     tạo mới. Đọc bản cũ trước để giữ phong cách nhất quán nếu còn phù hợp.
3. **Stamp provenance** — BẮT BUỘC, đừng tự viết front matter tay:
   ```bash
   node scripts/docs-i18n/stamp-pair.mjs <rel> <src>
   ```
   Ví dụ: file #1 `architecture/physical-collections.md` có `src=en` →
   `node scripts/docs-i18n/stamp-pair.mjs architecture/physical-collections.md en`
   Script này dùng chính các hàm hash/front-matter của `sync.mjs` nên provenance
   khớp tuyệt đối với cách tooling chính thức ghi.
4. **Xác minh**:
   ```bash
   nvm use 24   # bắt buộc — corepack/pnpm lỗi trên Node cũ hơn
   node scripts/docs-i18n/sync.mjs
   ```
   Chạy chế độ plan (không flag), chỉ đọc. Xem `docs/.i18n/last-report.json`, tìm
   `rel` của bạn — phải là `"type": "up-to-date"`. Nếu không, đọc lại bước 2/3.
5. **Dọn artifact máy trước khi commit** — bước này dễ quên và sẽ tạo diff rác:
   ```bash
   git checkout -- docs/.i18n/last-report.json docs/i18n-sync-log.md
   ```
   Hai file này bị ghi lại mỗi lần chạy detect ở bước 4. Chúng **không phải** nội
   dung dịch — không commit chúng cùng bản dịch (nếu cả nhóm đồng ý bạn có thể
   commit chúng RIÊNG ở cuối, nhưng không bắt buộc và dễ gây conflict nếu nhiều agent
   cùng ghi).
6. **Cập nhật bảng nhiệm vụ** (mục 3) — đổi cột Trạng thái của dòng đó thành `DONE`
   và cột Agent thành tên/id của bạn, trong CÙNG commit với bản dịch.
7. **Commit**:
   ```bash
   git add docs/en/<rel> docs/vi/<rel> docs/.i18n/TASKS.md
   git commit --no-verify -m "docs(i18n): translate <rel> to <VI|EN>"
   ```
   `--no-verify` vì pre-commit hook chạy toàn bộ test suite (chậm, không liên quan
   tới thay đổi docs-only). Không cần chạy test cho thay đổi chỉ đụng `docs/`.

## 2. Chạy song song — quy tắc bắt buộc để tránh xung đột

Nếu bạn là một trong nhiều agent làm việc đồng thời trên branch `docs/i18n-full-translation`:

- **Claim trước khi dịch.** Trước khi bắt đầu một file: `git pull --rebase`, mở bảng
  ở mục 3, chọn một hoặc vài dòng còn `TODO`, đổi ngay thành `CLAIMED` + tên bạn,
  commit + push ngay lập tức (commit rỗng về nội dung dịch, chỉ đổi bảng). Việc này
  là "khóa" tạm — agent khác pull thấy `CLAIMED` sẽ bỏ qua dòng đó.
- **Một file = một unit, không chia nhỏ hơn.** Đừng hai agent cùng sửa một file.
  Nếu bạn thấy dòng đã `CLAIMED` hoặc `DONE`, chuyển sang file khác.
- **Commit nhỏ, push thường xuyên.** Mỗi file một commit riêng (như mục 1 bước 7),
  `git pull --rebase` trước mỗi push để giảm xung đột. Nếu `push` bị từ chối do
  người khác đã push trước, `git pull --rebase` rồi push lại — không `--force`.
- **Xung đột chỉ nên xảy ra ở `TASKS.md`** (bảng này) vì mỗi agent chỉ đụng file
  docs riêng của mình. Nếu conflict xảy ra ở bảng, giữ **cả hai** thay đổi trạng thái
  (không có dòng nào bị mất) — merge tay theo dòng, đây là bảng text nên dễ resolve.
- **Không ai được sửa nhóm E** (`features/user-management.md`) — xem mục 4.
- **Không ai commit `docs/.i18n/last-report.json` hoặc `docs/i18n-sync-log.md`**
  trừ khi bạn là agent cuối cùng chốt cả PR — tránh nhiều agent giẫm lên artifact
  máy sinh của nhau.

Nếu bạn là agent DUY NHẤT (chạy tuần tự qua nhiều phiên), vẫn nên cập nhật bảng
(bỏ qua bước "claim trước", cứ đánh `DONE` sau khi xong) để phiên sau biết tiến độ
chính xác mà không cần chạy lại detect.

## 3. Bảng nhiệm vụ (94 file)

Sắp theo nhóm rồi theo độ dài tăng dần trong nhóm. Ưu tiên làm nhóm A/D trước (an
toàn — chỉ tạo file mới hoặc dịch chiều hiếm, không ghi đè). Nhóm B/C ghi đè nội
dung đang có ở phía đích — đọc kỹ bước 2 (mục 1) trước khi ghi.

| # | Nhóm | File (rel) | Nguồn→Đích | Dòng | Trạng thái | Agent |
|---|---|---|---|---|---|---|
| 1 | A | `architecture/physical-collections.md` | en→vi | 81 | TODO | — |
| 2 | A | `deployment/cloudflare-pages-ci.md` | en→vi | 92 | TODO | — |
| 3 | A | `contributing/code-first-config.md` | en→vi | 95 | TODO | — |
| 4 | A | `features/deployment-integrations.md` | en→vi | 100 | TODO | — |
| 5 | A | `agent-setup/index.md` | en→vi | 106 | TODO | — |
| 6 | A | `contributing/docs-i18n.md` | en→vi | 109 | TODO | — |
| 7 | A | `devpost-xprize-submission.md` | en→vi | 109 | TODO | — |
| 8 | A | `aio/README.md` | en→vi | 115 | TODO | — |
| 9 | A | `agent-setup/codex.md` | en→vi | 119 | TODO | — |
| 10 | A | `agent-setup/windsurf.md` | en→vi | 125 | TODO | — |
| 11 | A | `agent-setup/claude-code.md` | en→vi | 130 | TODO | — |
| 12 | A | `deployment/shared-domain-environments.md` | en→vi | 135 | TODO | — |
| 13 | A | `agent-setup/cursor.md` | en→vi | 140 | TODO | — |
| 14 | A | `features/push-notifications.md` | en→vi | 146 | TODO | — |
| 15 | A | `cdc/setup-materialized-engine.md` | en→vi | 153 | TODO | — |
| 16 | A | `contributing/index.md` | en→vi | 153 | TODO | — |
| 17 | A | `cdc/setup-airbyte.md` | en→vi | 155 | TODO | — |
| 18 | A | `getting-started.md` | en→vi | 157 | TODO | — |
| 19 | A | `cdc/setup-debezium-kafka.md` | en→vi | 158 | TODO | — |
| 20 | A | `agent-setup/github-copilot.md` | en→vi | 159 | TODO | — |
| 21 | A | `sdk/typegen.md` | en→vi | 163 | TODO | — |
| 22 | A | `cdc/deployment-cloudflare-workers.md` | en→vi | 170 | TODO | — |
| 23 | A | `agent-setup/prompt.md` | en→vi | 175 | TODO | — |
| 24 | A | `api/graphql-api-spec.md` | en→vi | 188 | TODO | — |
| 25 | A | `contributing/code-style.md` | en→vi | 188 | TODO | — |
| 26 | A | `cdc/deployment-docker-compose.md` | en→vi | 193 | TODO | — |
| 27 | A | `cdc/troubleshooting.md` | en→vi | 198 | TODO | — |
| 28 | A | `cdc/architecture.md` | en→vi | 201 | TODO | — |
| 29 | A | `cdc/environment-variables.md` | en→vi | 224 | TODO | — |
| 30 | A | `contributing/extension-dev.md` | en→vi | 242 | TODO | — |
| 31 | A | `contributing/testing.md` | en→vi | 261 | TODO | — |
| 32 | A | `sdk/javascript.md` | en→vi | 353 | TODO | — |
| 33 | A | `DEPLOYMENT-CHECKLIST.md` | en→vi | 530 | TODO | — |
| 34 | A | `features/directus-data-model-parity-tasks.md` | en→vi | 562 | TODO | — |
| 35 | A | `aio/AIO-AUDIT-REPORT.md` | en→vi | 668 | TODO | — |
| 36 | D | `release/npm-publishing.md` | vi→en | 42 | TODO | — |
| 37 | D | `roadmap/agent-harness-implementation.md` | vi→en | 123 | TODO | — |
| 38 | D | `features/permission-builder-directus-investigation.md` | vi→en | 1052 | TODO | — |
| 39 | B | `roadmap/phase-d1-users.md` | en→vi | 21 | TODO | — |
| 40 | B | `tutorials/index.md` | en→vi | 43 | TODO | — |
| 41 | B | `security/idor-testing.md` | en→vi | 50 | TODO | — |
| 42 | B | `compliance/data-residency.md` | en→vi | 54 | TODO | — |
| 43 | B | `architecture/page-hydration.md` | en→vi | 68 | TODO | — |
| 44 | B | `compliance/data-map.md` | en→vi | 69 | TODO | — |
| 45 | B | `features/permission-service-compose-audit.md` | en→vi | 72 | TODO | — |
| 46 | B | `security/dependency-overrides.md` | en→vi | 72 | TODO | — |
| 47 | B | `compliance/dpa-template.md` | en→vi | 77 | TODO | — |
| 48 | B | `compliance/market-us.md` | en→vi | 77 | TODO | — |
| 49 | B | `deployment/overview.md` | en→vi | 78 | TODO | — |
| 50 | B | `deployment/cloudflare.md` | en→vi | 81 | TODO | — |
| 51 | B | `compliance/market-vietnam.md` | en→vi | 83 | TODO | — |
| 52 | B | `compliance/provider-google-apple.md` | en→vi | 84 | TODO | — |
| 53 | B | `compliance/market-eu-gdpr.md` | en→vi | 89 | TODO | — |
| 54 | B | `compliance/README.md` | en→vi | 90 | TODO | — |
| 55 | B | `compliance/gap-analysis.md` | en→vi | 91 | TODO | — |
| 56 | B | `features/access-manifest-v1.md` | en→vi | 98 | TODO | — |
| 57 | B | `features/firebase-sync.md` | vi→en | 108 | TODO | — |
| 58 | B | `features/system-collections-access.md` | en→vi | 118 | TODO | — |
| 59 | B | `deployment/docker.md` | en→vi | 126 | TODO | — |
| 60 | B | `compliance/implementation-checklist.md` | en→vi | 127 | TODO | — |
| 61 | B | `README.md` | vi→en | 136 | TODO | — |
| 62 | B | `ai-skills.md` | en→vi | 141 | TODO | — |
| 63 | B | `operations/upgrades.md` | en→vi | 144 | TODO | — |
| 64 | B | `features/collections-builder.md` | en→vi | 150 | TODO | — |
| 65 | B | `features/search.md` | en→vi | 154 | TODO | — |
| 66 | B | `compliance/user-rights-catalog.md` | en→vi | 161 | TODO | — |
| 67 | B | `security/runtime-security-guards-plan.md` | en→vi | 169 | TODO | — |
| 68 | B | `features/typegen.md` | en→vi | 171 | TODO | — |
| 69 | B | `features/field-types-and-config.md` | en→vi | 178 | TODO | — |
| 70 | B | `deployment/environment-variables.md` | en→vi | 184 | TODO | — |
| 71 | B | `features/websockets-realtime.md` | en→vi | 191 | TODO | — |
| 72 | B | `deployment/local-development.md` | en→vi | 203 | TODO | — |
| 73 | B | `architecture/realtime-websocket-implementation.md` | en→vi | 256 | TODO | — |
| 74 | B | `features/role-policy-flag-migration.md` | en→vi | 258 | TODO | — |
| 75 | B | `features/agent-harness-layer.md` | en→vi | 307 | TODO | — |
| 76 | B | `tutorials/nextjs-quickstart.md` | en→vi | 431 | TODO | — |
| 77 | B | `data-model.md` | en→vi | 471 | TODO | — |
| 78 | B | `api/hono-api-spec.md` | en→vi | 1007 | TODO | — |
| 79 | C | `features/marketplace-ui.md` | vi→en | 37 | TODO | — |
| 80 | C | `features/raw-data-editing.md` | vi→en | 49 | TODO | — |
| 81 | C | `features/translations-i18n.md` | vi→en | 50 | TODO | — |
| 82 | C | `features/bookmarks-presets.md` | vi→en | 57 | TODO | — |
| 83 | C | `features/display-templates.md` | vi→en | 57 | TODO | — |
| 84 | C | `roadmap/collection-create-modes.md` | vi→en | 76 | TODO | — |
| 85 | C | `features/materialized-collections.md` | vi→en | 77 | TODO | — |
| 86 | C | `features/translation-memory.md` | vi→en | 82 | TODO | — |
| 87 | C | `features/scim-provisioning.md` | vi→en | 89 | TODO | — |
| 88 | C | `mcp/index.md` | vi→en | 93 | TODO | — |
| 89 | C | `mcp/mcp-application-analysis.md` | vi→en | 134 | TODO | — |
| 90 | C | `features/cloudflare-auth.md` | vi→en | 137 | TODO | — |
| 91 | C | `ui/studio-ui-spec.md` | vi→en | 139 | TODO | — |
| 92 | C | `roadmap/studio-content-slices.md` | vi→en | 212 | TODO | — |
| 93 | C | `roadmap/post-ga-walkthrough.md` | vi→en | 235 | TODO | — |
| 94 | C | `features/ai-first-specification.md` | vi→en | 316 | TODO | — |

**Định nghĩa nhóm** (để hiểu vì sao hướng dịch/rủi ro khác nhau):
- **A** — `docs/vi/<rel>` chưa tồn tại. Chỉ tạo file mới, không đè gì. An toàn nhất.
- **D** — `docs/en/<rel>` chưa tồn tại (hiếm, đối xứng với A). Chỉ tạo file mới.
- **B** — cả hai bên tồn tại nhưng nguồn đã đổi sau lần sync trước; bạn đang **ghi đè**
  bản dịch cũ ở phía đích. Đọc bản cũ trước để không làm mất context/quyết định đã có.
- **C** — file phía `docs/en/<rel>` thực ra được viết bằng tiếng Việt (trùng nội dung
  với `docs/vi/<rel>`). Việc của bạn là **viết lại phía EN** thành tiếng Anh thật,
  dịch từ nội dung VI hiện có (đó là lý do cột Nguồn→Đích ghi `vi→en`) — không sửa
  file VI.

## 4. Nhóm E — KHÔNG tự động xử lý

`features/user-management.md` — cả `docs/en` và `docs/vi` đã tồn tại, đều là tiếng
Việt, nhưng **nội dung khác nhau** (không phải một là bản dịch của bên còn lại — có
khả năng là hai phiên bản đã trôi độc lập). Không có cách máy nào chọn đúng "cái nào
là sự thật". Không có agent nào được tự quyết và ghi đè. Nếu bạn là agent được giao
xử lý mục này: dừng lại, so sánh hai file (`git diff --no-index docs/en/features/user-management.md
docs/vi/features/user-management.md` sau khi dịch tạm một bên sang ngôn ngữ chung để
so), tóm tắt khác biệt, và báo lại cho người điều phối (không tự commit).

## 5. Khi bảng hết TODO

1. Chạy detect lần cuối: `nvm use 24 && node scripts/docs-i18n/sync.mjs`.
2. Xác nhận `planned: 0` (trừ nhóm E nếu chưa được người quyết) trong output.
3. `git checkout -- docs/.i18n/last-report.json docs/i18n-sync-log.md` (không commit).
4. Không tự merge PR #205 — báo lại cho người điều phối (chủ repo) để họ review và merge.

## 6. Vì sao thủ công (đừng "tối ưu" bằng cách bật API key)

`scripts/docs-i18n/sync.mjs --apply` **có thể** tự dịch bằng Claude API nếu
`ANTHROPIC_API_KEY` được set — nhưng quyết định của người điều phối dự án là **không**
dùng đường đó cho batch này (đã cân nhắc chi phí API + muốn kiểm soát chất lượng dịch
qua LLM đọc hiểu trực tiếp thay vì pipeline không giám sát). Đừng tự thêm key vào
môi trường hoặc đề xuất chạy `--apply` để "xong nhanh hơn" — nếu bạn thấy cách đó rõ
ràng tốt hơn, hỏi người điều phối, không tự quyết.
