# Tasks — Site Skills

- [x] 1. Schema `site-skills.ts`, migration `0026_site_skills.sql` + journal, RLS list (Req 1, 11)
- [x] 2. `SiteSkillService`: định dạng tài liệu, hash, match, ngân sách, CRUD, version, import/export (Req 1–3, 6, 7, 9)
- [x] 3. Route `/api/v1/agent/skills` + mount (Req 9)
- [x] 4. Chèn: generation tools (`completeGuided`), Copilot sync + async, MCP `prompts/list|get` (Req 4, 5, 8)
- [x] 5. Test: `site-skill-service.test.ts` (thuần) + `site-skills.db.integration.test.ts` (Postgres thật: vòng đời, guard, hai site, import/export, ba bề mặt chèn, `resolveSafe`) (Req 2–12)
- [x] 6. CLI `lumibase skills list|pull|push|install` + test (Req 10)
- [x] 7. Studio: Mission Control → Skills + test (Req 13)
- [x] 8. Docs song ngữ (`features/site-skills`, API spec, data model, CLI, MCP), CHANGELOG, Setup Impact Registry, backlog
- [ ] 9. Benchmark chất lượng output với model thật (eval dataset "house style": so output có/không có skill). Cần LLM key trong CI — chưa có. Owner: maintainer.
- [ ] 10. Marketplace listing type `skill` (backlog B199).
- [ ] 11. stdio MCP server (`packages/mcp-server`) chuyển tiếp `prompts/*` (backlog B200).
- [ ] 12. Agent đề xuất skill qua harness tool có HITL (backlog B201).
- [x] 13. Review #781: MCP prompts chỉ cho control-plane admin; mọi thao tác ghi cần admin (gỡ `skills:write`, `RISK_REQUIRES_ADMIN`); ghi trong transaction; trần thân = ngân sách 12.000; import không đổi skill active nếu thiếu `updateActive`; `expectedVersion`/`version` (409 `VERSION_MISMATCH`); không xoá skill đã từng active; trigger Copilot theo các lượt gần nhất; sửa `\"` trong list inline, chuẩn hoá thân ở JSON API, sanitiser thẻ có khoảng trắng. Test: `site-skills-access.db.integration.test.ts` (chuỗi middleware thật) + các mục mới trong `site-skills.db.integration.test.ts`, `site-skill-service.test.ts`
- [ ] 14. Tác giả skill được uỷ quyền, không phải admin (backlog B214).
