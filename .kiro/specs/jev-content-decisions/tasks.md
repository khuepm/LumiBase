# Jev delivery backlog — Epic và task

Epic: [#507 — Jev: trusted draft review and governed content automation](https://github.com/khuepm/LumiBase/issues/507).
Ngày lập: 2026-10-06. Baseline PR #504: `73d3ca5e7c455f40a97aaf295fdd9acad094d3f2`.

GitHub Issues là nguồn trạng thái và acceptance chuẩn; checklist dưới đây là breakdown của spec. J01 đã triển khai trên nhánh `codex/508-jev-answer-validation`, đang chờ review/merge; các task còn lại chưa bắt đầu. Trước nhận việc kiểm tra issue/head mới, không suy trạng thái hiện tại từ bản snapshot này.

## Thứ tự thực hiện

1. **A — Nền tảng:** J01 → J02; J03 sau J01. Reconcile với PR #504 trước khi code.
2. **B — MVP Kiểm tra bản nháp:** J04 → J05 → J07 → J08; J06 benchmark sau nền tảng/profile; J09 sau J06 và J08.
3. **C — Automation:** J10 sau pilot J09; J11/J12 sau J10 và J06. Giữ deferred cho đến khi có evidence.

Priority chỉ áp dụng trong chương trình Jev. Chưa có assignee hoặc deadline; không tự dispatch agent. J01–J03 không ép milestone Post-v1 vì có thể sửa ngay trong PR #504. Epic và tính năng mới J04–J12 dùng milestone Post-v1.

| Task | Issue | Ưu tiên | Depends on | Phạm vi sở hữu dự kiến |
|---|---|---|---|---|
| J01 | [#508](https://github.com/khuepm/LumiBase/issues/508) | P0 | [PR #504](https://github.com/khuepm/LumiBase/pull/504) | apps/cms/src/services/decision-provider.ts; provider/route tests |
| J02 | [#509](https://github.com/khuepm/LumiBase/issues/509) | P0 | [J01 #508](https://github.com/khuepm/LumiBase/issues/508) | apps/cms/src/services/decision-provider.ts; apps/cms/src/routes/ai.ts; env/runtime wiring; tests |
| J03 | [#510](https://github.com/khuepm/LumiBase/issues/510) | P1 | [J01 #508](https://github.com/khuepm/LumiBase/issues/508) | apps/cms/src/services/decision-provider.ts; llm-provider.ts; provider contract tests |
| J04 | [#511](https://github.com/khuepm/LumiBase/issues/511) | P1 | [J01 #508](https://github.com/khuepm/LumiBase/issues/508), [J02 #509](https://github.com/khuepm/LumiBase/issues/509) | apps/cms/src/routes/ai.ts; permission/governance services; runtime rate limiter; audit; packages/contracts |
| J05 | [#512](https://github.com/khuepm/LumiBase/issues/512) | P1 | [J04 #511](https://github.com/khuepm/LumiBase/issues/511) | packages/contracts; packages/database schema/migrations; apps/cms/src/services and routes for content review |
| J06 | [#513](https://github.com/khuepm/LumiBase/issues/513) | P1 | [J01 #508](https://github.com/khuepm/LumiBase/issues/508), [J02 #509](https://github.com/khuepm/LumiBase/issues/509), [J03 #510](https://github.com/khuepm/LumiBase/issues/510), [J05 #512](https://github.com/khuepm/LumiBase/issues/512) | CMS evaluation scripts/fixtures/tests; docs/en and docs/vi feature evidence |
| J07 | [#514](https://github.com/khuepm/LumiBase/issues/514) | P1 | [J03 #510](https://github.com/khuepm/LumiBase/issues/510), [J05 #512](https://github.com/khuepm/LumiBase/issues/512) | packages/contracts; packages/sdk/src/rest; SDK exports; apps/cms/openapi.yaml; docs/en and docs/vi |
| J08 | [#515](https://github.com/khuepm/LumiBase/issues/515) | P1 | [J05 #512](https://github.com/khuepm/LumiBase/issues/512), [J07 #514](https://github.com/khuepm/LumiBase/issues/514) | apps/studio/src/modules/content/item-detail.tsx; item-create.tsx; editorial-actions.tsx; review UI/tests/i18n |
| J09 | [#516](https://github.com/khuepm/LumiBase/issues/516) | P1 | [J06 #513](https://github.com/khuepm/LumiBase/issues/513), [J08 #515](https://github.com/khuepm/LumiBase/issues/515) | review telemetry/insights; feature flags; docs/en and docs/vi; pilot report |
| J10 | [#517](https://github.com/khuepm/LumiBase/issues/517) | P2 | [J09 #516](https://github.com/khuepm/LumiBase/issues/516) | apps/cms/src/services/flow-service.ts; flow runner/worker; apps/studio flow palette; contracts |
| J11 | [#518](https://github.com/khuepm/LumiBase/issues/518) | P2 | [J06 #513](https://github.com/khuepm/LumiBase/issues/513), [J10 #517](https://github.com/khuepm/LumiBase/issues/517) | editorial/item services; governed AI harness; flow templates; Studio review queue |
| J12 | [#519](https://github.com/khuepm/LumiBase/issues/519) | P2 | [J06 #513](https://github.com/khuepm/LumiBase/issues/513), [J10 #517](https://github.com/khuepm/LumiBase/issues/517) | apps/cms/src/services/drift-service.ts; intent-service.ts; reconciler-service.ts; Mission Control |

## A — Nền tảng đáng tin cậy

- [ ] **J01 — [fix(ai): J01 reject malformed Jev answers and invalid probability distributions](https://github.com/khuepm/LumiBase/issues/508)**
  - Đầu ra: Validate từng answer theo loại câu hỏi bằng runtime schema; thiếu, null, sai kiểu, NaN/Infinity hoặc ngoài miền phải trả DECISION_PARSE_FAILED.
  - Nghiệm thu chính: Regression: answers.unsafe = {} không được trở thành noul=0; score thiếu không thành 0.
- [ ] **J02 — [feat(ai): J02 bound decision timeouts, retries and total input size](https://github.com/khuepm/LumiBase/issues/509)**
  - Đầu ra: Thêm deadline tổng, timeout mỗi attempt và cancellation qua AbortSignal; map network/abort sang lỗi gateway ổn định.
  - Nghiệm thu chính: Fake-clock tests chứng minh tổng thời gian bị chặn và không có retry sau cancel.
- [ ] **J03 — [fix(ai): J03 align LLM decision semantics and disable tool calling](https://github.com/khuepm/LumiBase/issues/510)**
  - Đầu ra: Bổ sung chế độ structured decision trong LLM abstraction: system instruction đúng, không gắn CORE_SKILLS và không cho tool calling; không thay đổi hành vi chat hiện tại.
  - Nghiệm thu chính: Inspect request thực của adapter qua mocked fetch cho OpenAI-compatible, Anthropic, Gemini/Vertex và Workers AI: đúng system prompt, không có tools.

## B — MVP Kiểm tra bản nháp

- [ ] **J04 — [feat(ai): J04 govern decision access, tenant budgets and audit events](https://github.com/khuepm/LumiBase/issues/511)**
  - Đầu ra: Chốt capability sử dụng decisions, phân loại route theo DoD; enforce trên HTTP/SDK và các caller nội bộ tương ứng. Giữ auth, membership, row/field RBAC hiện có.
  - Nghiệm thu chính: Tests deny anonymous/không capability/cross-site trước gọi provider; quota bị vượt không gọi upstream.
- [ ] **J05 — [feat(ai): J05 add versioned review profiles and item-bound decision runs](https://github.com/khuepm/LumiBase/issues/512)**
  - Đầu ra: Tạo review profile theo site/collection: fields được đọc, taxonomy cho choice, rubric atomic cho tone/brief alignment, noul cho cờ cần review; có other/unknown khi thích hợp.
  - Nghiệm thu chính: Tests cô lập tenant/field RBAC và profile permissions; snapshot chứa field cấm bị từ chối.
- [ ] **J06 — [test(ai): J06 benchmark Jev on Vietnamese and English editorial data](https://github.com/khuepm/LumiBase/issues/513)**
  - Đầu ra: Chuẩn bị ít nhất 200 mẫu có nhãn, tối thiểu 100 VI và 100 EN, gồm ambiguous/out-of-taxonomy, prompt injection và nội dung cần review. Dùng dữ liệu synthetic hoặc đã được phép, không gửi dữ liệu người dùng mặc định.
  - Nghiệm thu chính: Command tái lập sinh report có phiên bản và sample counts; dữ liệu held-out không bị leak vào tuning.
- [ ] **J07 — [feat(sdk): J07 expose typed decisions, draft review and feedback APIs](https://github.com/khuepm/LumiBase/issues/514)**
  - Đầu ra: Thêm client methods phù hợp convention SDK cho decision/review/profile-read/feedback; dùng shared contracts, không duplicate schema.
  - Nghiệm thu chính: SDK integration/contract tests cho success, forbidden, stale, timeout, quota và disabled.
- [ ] **J08 — [feat(studio): J08 ship draft review suggestions and editor feedback](https://github.com/khuepm/LumiBase/issues/515)**
  - Đầu ra: Nút Kiểm tra bản nháp cho nội dung saved/unsaved; hiển thị chuyên mục đề xuất và từng tiêu chí, trạng thái chưa đủ thông tin và nguồn provider.
  - Nghiệm thu chính: E2E editor → review → accept/edit → save draft → feedback; publish vẫn cần thao tác/quyền hiện có.
- [ ] **J09 — [feat(ai): J09 validate draft-review pilot, metrics and rollout controls](https://github.com/khuepm/LumiBase/issues/516)**
  - Đầu ra: Pilot opt-in theo site với nhóm nội dung xác định; đo baseline thời gian review trước khi bật Jev.
  - Nghiệm thu chính: Một report có baseline, sample counts và kết quả đo thực; không có dữ liệu thật thì giữ issue mở/unverified.

## C — Automation sau pilot

- [ ] **J10 — [feat(flows): J10 add governed AI decision operations and explicit branches](https://github.com/khuepm/LumiBase/issues/517)**
  - Đầu ra: Thêm operation ai:decision dùng profile version và context được phép, qua service governance/quota/audit dùng chung.
  - Nghiệm thu chính: Integration flow mẫu chứng minh từng nhánh thực sự chạy đúng node và không chạy node nhánh khác.
- [ ] **J11 — [feat(editorial): J11 automate low-risk tagging and review-queue routing](https://github.com/khuepm/LumiBase/issues/518)**
  - Đầu ra: Template opt-in cho taxonomy tagging và editorial queue routing; thresholds riêng theo locale/action/provider/model/profile.
  - Nghiệm thu chính: Đo precision/coverage trong vùng auto-action theo ngưỡng chốt ở J06; không đủ mẫu thì giữ shadow.
- [ ] **J12 — [feat(content-os): J12 detect semantic drift against versioned Content Intents](https://github.com/khuepm/LumiBase/issues/519)**
  - Đầu ra: Thêm semantic rule types nhỏ, có version và nguồn context rõ; giữ required_fields/freshness/glossary checks bằng code.
  - Nghiệm thu chính: Fixtures VI/EN có semantic drift thật và false positives; benchmark theo J06.

## Điều phối và bằng chứng

- Mỗi task có parent epic, native sub-issue, Depends on trong body và native blocked-by khi đã xác minh trên GitHub.
- Scope/acceptance đầy đủ ở issue; PR ghi head SHA, tests, failures/skips và applicable DoD. Không đóng chỉ vì compile pass.
- Token hiện có chưa cho phép đọc Project #7 hoặc tạo board dưới owner khuepm; dùng issue backlog và không tạo bản sao. Khi có quyền, thêm chính các issue này vào Project.
- Spec requirements/design là kế hoạch thiết kế, không khẳng định tính năng đã ship. Chưa commit/push bộ spec trong lượt tạo backlog.

## Execution evidence — J01, 2026-10-06

- Baseline: PR #504 `73d3ca5e7c455f40a97aaf295fdd9acad094d3f2`.
- Implemented: strict own-field/type/range/distribution validation, required confidence, malformed-result 502, no numeric clamp/default for decisions.
- Verification: provider/route regressions and 100-run probability property; actual results recorded on #508 and the linked PR. Live provider keys/runtime deployment remain unverified.
- J01 checklist stays open pending PR review and integrated acceptance. J02/J03 remain separate tasks.
