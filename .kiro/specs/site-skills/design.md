# Design — Site Skills

## 1. Dữ liệu

`packages/database/src/schema/site-skills.ts`, migration viết tay
`0026_site_skills.sql` (idempotent, không đụng bảng có sẵn):

- `lumibase_site_skills` — trạng thái hiện tại: slug, name, description,
  status, riskClass, priority, các cột phạm vi (jsonb), body, version, hash,
  source/sourceRef. Unique `(site_id, slug)`.
- `lumibase_site_skill_versions` — vết bất biến: unique `(skill_id, version)`,
  snapshot, hash, source, changeNote, author.

Cả hai có `site_id` và nằm trong danh sách `site_isolation` của
`rls-policies.sql`. Mỗi lần ghi (create, update — nên cả restore và import —,
đổi status, xoá) chạy trong **một transaction** (`runSiteTransaction`): dòng
skill, dòng phiên bản và mục activity cùng commit hoặc cùng rollback. Update và
đổi status khoá dòng skill (`SELECT … FOR UPDATE`) rồi mới đọc version hiện
tại; unique `(skill_id, version)` vẫn là chốt chặn cuối, lỗi trùng thành
`409 CONFLICT`. (Bản đầu không có transaction: update hỏng ở câu lệnh thứ hai
để lại phiên bản N+1 trong khi skill vẫn ở N, và mọi lần ghi sau đó `409` mãi
— review #781 mục 3.)

## 2. Service — `apps/cms/src/services/site-skill-service.ts`

Phần thuần (không DB): `parseSkillDocument` / `serializeSkillDocument` (tập con
YAML tự viết để chạy trên Workers, key lạ là lỗi), `computeSkillHash`
(sha256 trên dạng canonical, không gồm slug), `skillApplies`,
`composeSkillPrompt`, `withSiteSkills`.

Phần DB: CRUD, `setStatus`, `listVersions`, `restoreVersion` (ghi thành phiên
bản mới), `importDocuments` (upsert theo slug, báo từng tài liệu, `dryRun`),
`exportDocuments`, `resolve` / `resolveSafe`, `listForMcp`.

### Quyết định

- **D1 — Tên.** "Skill" đã là tên tool của harness. Bảng và service dùng tiền
  tố `site` (`site_skills`, `SiteSkillService`); docs mở đầu bằng ghi chú phân
  biệt.
- **D2 — Skill nằm ở system slot.** Được phép vì **mọi** thao tác ghi skill cần
  control-plane admin (route kiểm tra `grant.allowed && grant.controlPlaneAdmin`
  sau guard) — cùng mức tin cậy với prompt `llm_judge` của constitution. Chưa có
  tác giả được uỷ quyền: capability `skills:write` của bản đầu không principal
  nào có được nên đã bị gỡ (review #781 mục 2; backlog B214). Thân skill được
  bọc `<site-skill>` và các thẻ giả trong thân (kể cả viết có khoảng trắng như
  `< /site-skill>`, mọi kiểu hoa thường) bị vô hiệu; đoạn mở đầu nói rõ skill
  không đổi định dạng output, không cấp quyền.
- **D3 — Harness tự dựng resolver.** `buildCoreSkills` dựng `SiteSkillService`
  từ `db` + `siteId` nó đã có, thay vì nhận qua config, để không call site
  `new AISecureHarness` nào quên truyền (class lỗi DoD §2b "parity runtime
  provider").
- **D4 — Copilot dùng chung một hàm.** `resolveCopilotPlaybooks` được gọi ở cả
  route đồng bộ và worker; worker resolve capability **trước** lời gọi model để
  hai nửa của `POST /ai/chat` cho cùng kết quả. Trigger được so với 3 lượt user
  mới nhất (`COPILOT_TRIGGER_TURNS`) của cửa sổ hội thoại đã tải bằng
  `loadCopilotHistory`, cộng tin nhắn hiện tại — câu hỏi nối tiếp như "viết ngắn
  lại" vẫn giữ playbook của lượt trước.
- **D5 — Không skill → request không đổi.** `systemPrompt` là `undefined` khi
  không skill nào khớp.
- **D6 — `resolveSafe`.** Lỗi đọc skill không làm fail run (playbook là tư vấn,
  không phải kiểm soát bảo mật); có log cảnh báo.
- **D7 — Grounded generation được miễn** (trích nguyên văn, không văn phong).
- **D8 — `riskClass` chỉ là nhãn.** Lưu và hiện trong Studio để người duyệt
  biết xem gì trước; không phải bậc quyền. Bản đầu có `assertRisk` /
  `RISK_REQUIRES_ADMIN`, nhưng vì mọi người ghi đều là admin nên nó không bao giờ
  chặn ai — đã gỡ (review #781 mục 2).
- **D9 — MCP.** `McpHarnessPort.listPrompts/getPrompt` là tuỳ chọn; plane
  organization không khai nên không quảng bá `prompts`. `/mcp` không phải path
  control-plane, nên `routes/mcp.ts` tự áp quy tắc của REST: chỉ principal
  `grant.allowed && grant.controlPlaneAdmin` mới nhận prompt; người khác thấy
  `prompts/list` rỗng (review #781 mục 1). Bộ lọc surface/capability của từng
  skill vẫn áp lên trên. Prompt không tồn tại và prompt bị chặn trả lời giống
  nhau.
- **D10 — CLI mỏng.** CLI chỉ chuyển file; server parse. Một bản cài đặt định
  dạng duy nhất.
- **D11 — Không thêm harness tool.** Agent chưa tự đề xuất skill (xem backlog);
  số tool MCP không đổi.
- **D12 — Trần thân skill = ngân sách một run.** `MAX_SKILL_BODY_CHARS` bằng
  `MAX_INJECTED_CHARS` (12.000): một skill đã kích hoạt luôn chèn được khi đứng
  một mình. Bản đầu cho 20.000, nên skill 12.001–20.000 ký tự được kích hoạt mà
  không bao giờ được chèn. Thân được chuẩn hoá giống nhau ở JSON API và parser
  (bỏ dòng trống đầu, khoảng trắng cuối) để `pull` → `push` không tạo phiên bản
  chỉ khác khoảng trắng.
- **D13 — Import không đổi skill đang chạy nếu không được yêu cầu.** Thay đổi
  nội dung một skill `active` qua `/import` là lỗi của tài liệu đó
  (`ACTIVE_SKILL_CHANGE`) trừ khi request có `updateActive: true`. `skills push`
  (đường deploy) gửi cờ này; `skills install` thì không. `source`/`sourceRef`
  là nhãn client tự khai; tác giả do server ghi mới có thẩm quyền.
- **D14 — Optimistic concurrency.** `PATCH` nhận `expectedVersion`, các thao
  tác status nhận `version`; lệch thì `409 VERSION_MISMATCH` kèm
  `currentVersion`. Studio gửi cả hai.
- **D15 — Không xoá skill đã từng chạy.** Xoá cascade vết phiên bản mà run đã
  đóng dấu, và tạo lại slug sẽ bắt đầu lại từ v1. Nên skill có `activatedAt`
  bị từ chối (`409 SKILL_HAS_BEEN_ACTIVE`) — hãy archive; draft chưa từng
  active vẫn xoá được. Audit `site_skill.deleted` có `skillId`.

## 3. Bề mặt

| Bề mặt | File |
|---|---|
| REST `/api/v1/agent/skills` | `apps/cms/src/routes/site-skills.ts` |
| Copilot | `routes/ai.ts`, `services/ai-chat-run-worker.ts` |
| Generation tools | `services/ai-harness.ts` (`completeGuided`) |
| MCP prompts | `services/mcp-service.ts`, `routes/mcp.ts` |
| CLI | `packages/cli/src/commands/skills.ts` |
| Studio | `apps/studio/src/modules/mission-control/skills-page.tsx` (+ editor, versions, match preview) |

## 4. Phân loại route (DoD §2c)

Control plane: nằm dưới `/api/v1/agent`, đã có trong `CONTROL_PLANE_PATHS`.
Không thêm path public/bypass nào.

## 5. Multi-tenant (DoD §2b)

Cô lập: hai bảng. Dùng chung: hằng số ngân sách + đoạn mở đầu (không phải dữ
liệu tenant). Không cache, không queue, không khoá hạ tầng mới. Worker đọc skill
bằng `siteId` của job.
