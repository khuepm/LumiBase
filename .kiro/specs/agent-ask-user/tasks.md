# Tasks — `askUser` (issue #710)

> Status: **Implemented**. Requirements: [requirements.md](requirements.md). Design: [design.md](design.md). Không migration.

## Contract
- [x] 1.1 `askUser` + `getUserAnswer` trong `AgentToolSchemas` (`packages/contracts`), `ASK_USER_LIMITS`, `ASK_USER_DEFAULT_TIMEOUT_MINUTES` (Req 1.1–1.2).
- [x] 1.2 Descriptor Copilot trong `packages/ai-skills`; fixture `canonical-agent-tool-schemas.json` của `packages/mcp-server` (Req 1.1).

## Harness + service
- [x] 2.1 `AgentQuestionService` (`apps/cms/src/services/agent-question-service.ts`): `ask`, `list`, `get`, `answer`, `expire`, `cancelWaitingRuns`, `closeOpenQuestionsForRun`, `sweepExpiredQuestions` (Req 1–4).
- [x] 2.2 `AgentRunService.awaitUser`, `WAITING_USER_RUN_STATUS`; `cancelRun` đóng question; `waiting_user` vào `IN_FLIGHT_RUN_STATES` (Req 1.4, 4.1, 5.2).
- [x] 2.3 `AISecureHarness.execute` chặn `askUser` / `getUserAnswer` sau capability + policy; `parkForQuestion`, `readUserAnswer`; status `waiting_user` + `questionId` (Req 1.3–1.7, 2.6).
- [x] 2.4 Dispatcher: `waiting_user` in-flight (Req 5.2).
- [x] 2.5 Kill switch: freeze role/site, pause intent huỷ run đang chờ (Req 4.2).
- [x] 2.6 Reviewer từ chối question (`HUMAN_ONLY`) (Req 5.1).
- [x] 2.7 Worker `agent-runs` truyền notifier Web Push (Req 1.7).
- [x] 2.8 Metric + bằng chứng trust ledger (Req 7).

## Routes + runtime
- [x] 3.1 `GET /agent/questions`, `GET /agent/questions/:id`, `POST /agent/questions/:id/answer`; `GET /agent/approvals` loại question; `decide`/`reopen` → `409 NOT_AN_APPROVAL` (Req 2, 5.1).
- [x] 3.2 Sweep `agent-question-sweep` trong `serve.ts` (cron 5 phút, leader lock) và `cloudflare.ts` (tick 5 phút) (Req 3.1).
- [x] 3.3 `toToolDecision` thêm `questionId` (Req 6).
- [x] 3.4 `apps/cms/openapi.yaml`.

## Studio
- [x] 4.1 `AgentQuestion`, `missionControlApi.questions/answerQuestion` qua `agentFetch` (Req 9.2).
- [x] 4.2 `use-inbox`: entry `question`, `counts.questions`; approval list bỏ `kind = 'question'` (Req 9.1).
- [x] 4.3 `QuestionAnswerForm` trong inbox + detail pane; icon trong notifications panel; trạng thái `waiting_user` trong activity feed (Req 9.1).

## Test
- [x] 5.1 `agent-ask-user.db.integration.test.ts` (PostgreSQL thật): pause → answer → resume, queue path, MCP, sai principal, API key tự trả lời, tenant khác, trả lời đôi (tuần tự + đồng thời), validate, approval route từ chối, timeout (sweep + route), freeze site/role, đua freeze, cancel run, requester mất quyền, frozen không hỏi được, input sai không ghi gì.
- [x] 5.2 `agent-question-service.test.ts` (contract, helper, untrusted).
- [x] 5.3 `mcp-parity.property.test.ts` thêm `waiting_user`.
- [x] 5.4 Fake DB của `agent-run-state-machine.test.ts` / `kill-switch.property.test.ts` cập nhật cho bước mới.
- [x] 5.5 Studio `inbox-question.test.tsx`; `use-inbox.test.ts` thêm `questions`.

## Docs + DoD
- [x] 6.1 `docs/{en,vi}/features/agent-harness-layer.md`, `api/hono-api-spec.md`, `data-model.md`, `ai-skills.md`, `features/push-notifications.md`, `mcp/governed-tool-contract.md`, `mcp/index.md` — verify + stamp từng cặp.
- [x] 6.2 Setup Impact Registry dòng #202 (`n/a`).
- [x] 6.3 Backlog B207, B208, B209.
- [x] 6.4 CHANGELOG `[Unreleased]`.

## Review #784
- [x] 7.1 Loại `askUser` / `getUserAnswer` khỏi danh sách tool của Copilot chat (`chatToolSkills()`); test `llm-provider.test.ts`.
- [x] 7.2 Mọi API key (kể cả org key) bị từ chối ở route trả lời; test org key trong `agent-ask-user.db.integration.test.ts`.
- [x] 7.3 Trim + unique options trong contract; harness ghi input đã chuẩn hoá.
- [x] 7.4 `closeRun` / `failRun` / `awaitApproval` không đưa run ra khỏi `waiting_user`.
- [x] 7.5 Tool call `waiting_user` ghi trong transaction đỗ, trước notify.
- [x] 7.6 Worker chỉ phát `approval` / `question`; `waitUntil` (Workers) hoặc await (Docker); body câu hỏi được che.
- [x] 7.7 Comment + docs: nhánh requester chưa chạm tới được cho tới B207; không API key nào trả lời.
