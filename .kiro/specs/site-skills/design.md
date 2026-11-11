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
`rls-policies.sql`. Unique `(skill_id, version)` là trọng tài khi hai người ghi
đua nhau: version row được insert **trước** khi update skill, người thua nhận
`409 CONFLICT`.

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
- **D2 — Skill nằm ở system slot.** Được phép vì người viết nó có
  `skills:write`/admin trên route control-plane — cùng mức tin cậy với prompt
  `llm_judge` của constitution. Thân skill được bọc `<site-skill>` và các thẻ
  giả trong thân bị vô hiệu; đoạn mở đầu nói rõ skill không đổi định dạng
  output, không cấp quyền.
- **D3 — Harness tự dựng resolver.** `buildCoreSkills` dựng `SiteSkillService`
  từ `db` + `siteId` nó đã có, thay vì nhận qua config, để không call site
  `new AISecureHarness` nào quên truyền (class lỗi DoD §2b "parity runtime
  provider").
- **D4 — Copilot dùng chung một hàm.** `resolveCopilotPlaybooks` được gọi ở cả
  route đồng bộ và worker; worker resolve capability **trước** lời gọi model để
  hai nửa của `POST /ai/chat` cho cùng kết quả.
- **D5 — Không skill → request không đổi.** `systemPrompt` là `undefined` khi
  không skill nào khớp.
- **D6 — `resolveSafe`.** Lỗi đọc skill không làm fail run (playbook là tư vấn,
  không phải kiểm soát bảo mật); có log cảnh báo.
- **D7 — Grounded generation được miễn** (trích nguyên văn, không văn phong).
- **D8 — `riskClass`** có nghĩa vận hành: `high` chỉ admin được tạo/sửa/hạ
  mức/đổi status/xoá.
- **D9 — MCP.** `McpHarnessPort.listPrompts/getPrompt` là tuỳ chọn; plane
  organization không khai nên không quảng bá `prompts`. Prompt không tồn tại và
  prompt bị chặn capability trả lời giống nhau.
- **D10 — CLI mỏng.** CLI chỉ chuyển file; server parse. Một bản cài đặt định
  dạng duy nhất.
- **D11 — Không thêm harness tool.** Agent chưa tự đề xuất skill (xem backlog);
  số tool MCP không đổi.

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
