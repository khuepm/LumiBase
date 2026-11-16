# Design — `askUser` (issue #710)

> Status: **Implemented**. Requirements: [requirements.md](requirements.md). Tasks: [tasks.md](tasks.md).

## 1. Quyết định chính

| Quyết định | Chọn | Lý do |
|---|---|---|
| Lưu trữ | `agent_approvals` với `kind = 'question'` | Bảng đã có `site_id`, RLS, `expires_at`, `decided_by/at`, `decision_reason`, `requested_by_principal` (#472) và đã được mọi consumer lọc theo `kind` (veto, promotion). Không migration, không entry RLS mới, không cần §2b cho bảng mới. |
| Nơi giữ câu hỏi | `input` của tool call `askUser` (`subject_id`) | Harness vốn ghi input của mọi tool call; không nhân bản. |
| Nơi giữ câu trả lời | `decision_reason` (nguyên văn, cho operator) + output tool call (bọc untrusted, cho model) | Câu trả lời *là* quyết định của con người; output tool call là thứ model đọc. |
| Trạng thái run | `waiting_user` (text, không có CHECK) | Đúng tên trong issue; ngoài unique index `queued/running` như `awaiting_approval`. |
| Tiếp tục | Một transaction: question `pending→answered`, run `waiting_user→succeeded`, tool call `executed`, audit | Run của harness là **một** tool call; phần còn lại của run chính là hoàn tất tool call đó. Đi thẳng `→ succeeded` tránh trạng thái `running` trung gian va chạm unique index một-run-active-mỗi-goal và tránh một run `running` bị bỏ rơi nếu process chết giữa chừng. |
| Ai trả lời | Chỉ **user** đã đăng nhập: Approver (`approvals:decide` / control-plane admin) hoặc Requester là **user** | Approver vốn được tin để gỡ run đang đỗ, và là đường duy nhất cho run reconciler (không có người yêu cầu). Requester có ngữ cảnh. Mọi API key (scope site **và** organization, bất kể capability) bị từ chối *trước* nhánh approver: key là cách agent hành động — cho bên đã hỏi tự trả lời là đóng vòng lặp mà tool này mở ra. Review #784: org key được resolve thành `controlPlaneAdmin` nên trước đó lọt qua như approver (`via: 'approver'`, `decidedBy: null`). Hiện chỉ admin site tới được route (control-plane guard), nên nhánh requester chưa chạm tới được cho tới B207. |
| Timeout | Mặc định 1 ngày, tối đa 7 ngày; hết hạn → run `failed` (`question_timeout`) | `failed` (không phải `cancelled`): run không đạt mục đích và operator cần thấy; retry được; reconciler goal bị chặn chứ không tự hỏi lại. |
| Phát hiện hết hạn | Sweep 5 phút (`agent-question-sweep`) + route trả lời tự chốt | Run đang chờ không giữ gì nên không có gì khác nhận ra hạn chót. Không cần queue consumer mới ⇒ không đổi `WORKER_QUEUE_CONSUMERS`. |
| Kill switch | Freeze role/site, pause intent, cancel run ⇒ huỷ run `waiting_user` trong phạm vi | Run đang chờ không còn ranh giới tool call để gặp lệnh freeze. Route trả lời cũng kiểm freeze (đua với vòng huỷ). |
| Đọc câu trả lời | Tool `getUserAnswer` (chỉ Requester hoặc grant admin) | MCP client chỉ có `tools/call`; không có tool này agent không lấy được câu trả lời. Không cho mọi người `items:read` đọc hội thoại của agent khác. |
| MCP | `toToolDecision` thêm `questionId`; `isError` vẫn là `status === 'denied'` | Cùng quy tắc với `pending_approval` + `approvalId`. |
| Notification | Kind mới `question`; worker `agent-runs` nay truyền notifier Web Push **chỉ cho `approval` và `question`**; body câu hỏi được `maskSecrets` như input đã lưu; giữ sống bằng `waitUntil` của queue consumer trên Workers, `await` trên Docker | Câu hỏi từ run nền phải tới được người. Run trong hàng đợi trước đây im lặng về vòng đời — không biến mỗi run thành push succeeded/failed tới mọi subscriber (review #784). Push rời khỏi hệ thống nên không được mang nhiều hơn bản ghi. |
| Copilot chat | `askUser` / `getUserAnswer` **không** nằm trong danh sách tool của chat (`chatToolSkills()` trong `llm-provider.ts`, nguồn duy nhất cho mọi provider và cho ước lượng ngân sách context) | Chat thực thi một tool call mỗi lượt, không có run để đỗ/tiếp tục; nếu model chọn `askUser`, câu trả lời chat không chứa câu hỏi và run nằm `waiting_user` tới khi hết hạn (review #784). Harness/MCP/agent run vẫn có cả hai. |
| Options | Trim trong contract (`z.string().trim()`), phải khác nhau sau trim; harness ghi input đã chuẩn hoá của `askUser` | Câu trả lời được trim trước khi so với options; option `"yes "` + `allowFreeText: false` sẽ không bao giờ trả lời được (review #784). |
| Rời `waiting_user` | Chỉ qua câu hỏi (trả lời, hết hạn, huỷ). `closeRun`/`failRun` bỏ qua run `waiting_user` (kiểm khi đọc + predicate trong UPDATE); `awaitApproval` không nhận `waiting_user`; ngoại lệ duy nhất là `requester_revoked` của route trả lời (`{ fromWaitingUser: true }`), vốn tự đóng câu hỏi | Chọn guard thay vì "fail thì đóng câu hỏi": giữ run và câu hỏi nhất quán bằng cách không cho đường lỗi chung chung chạm vào run đang đỗ; câu hỏi vẫn trả lời được, và sweep vẫn chốt nó khi hết hạn (review #784). |

## 2. Luồng

```
execute('askUser')
  kill switch → validate input → ensureRun → cancelled? → budget → appendToolCall
  → capability (role ∩ grant) → policy
  → parkForQuestion:
      tx { runs.awaitUser (CAS queued|running→waiting_user); insert agent_approvals(kind=question);
           tool call running→waiting_user (CAS); insert activity agent_question.asked }
      notify(kind=question)   -- sau commit; tool call đã ghi trong tx nên câu trả lời đua không bị ghi đè
  ← { status: 'waiting_user', questionId, runId, goalId, toolCallId }

POST /agent/questions/:id/answer
  loadRow (site + kind) → 404 | questionAnswerer(): API key → 403, không phải approver/requester → 403
  AgentQuestionService.answer:
    closed? 409 | overdue? expire() + 409 | option check 400 | run waiting? 409
    frozen? cancelRun + 423 | requester re-resolve (#472)? failRun + 409
    tx { CAS question pending→answered (expires_at > now); CAS run waiting_user→succeeded;
         tool call executed (answer as untrusted); activity agent_question.answered }
```

Huỷ: `AgentRunService.cancelRun` luôn gọi `closeOpenQuestionsForRun` sau khi huỷ (không dựa vào status đã đọc — run có thể đỗ giữa lần đọc và UPDATE).

## 3. Tác động lên chỗ khác

- `IN_FLIGHT_RUN_STATES` (retry, cancel) và `ACTIVE_RUN_STATES` / `noRunInFlight` (dispatcher) thêm `waiting_user`.
- `GET /agent/approvals` loại `kind = 'question'`; `decide`/`reopen` trả `409 NOT_AN_APPROVAL`; `ReviewerService` trả `HUMAN_ONLY`.
- Metric: `agentQuestionsTotal`, `agentQuestionWait`; `metricReason` thêm `answered`, `question_timeout`, `frozen`; `metricStatus` thêm `waiting_user`.
- Trust ledger: bằng chứng `questions`.
- Studio: `AgentQuestion`, `missionControlApi.questions/answerQuestion`, entry `question` trong `use-inbox`, `QuestionAnswerForm` trong inbox + detail pane, icon trong notifications panel, đếm "awaiting decision".

## 4. Multi-tenancy (DoD §2b)

| Tài nguyên | Phạm vi |
|---|---|
| Dòng question, run, tool call, activity | Cô lập theo `site_id` (bảng có RLS sẵn) |
| Route list/get/answer | Mọi query lọc `site_id`; id site khác → 404 |
| Notification | Fan-out lọc `siteId` (cơ chế sẵn có) |
| Sweep | Dùng chung deployment, system connection, chốt từng dòng trong site của nó |

Kiểm bằng `agent-ask-user.db.integration.test.ts` (hai site, PostgreSQL thật).

## 5. Ngoài phạm vi

- Gửi câu hỏi qua Slack (#711).
- Requester không phải admin tự trả lời qua Studio: route nằm dưới control-plane guard của `/api/v1/agent` (backlog B207).
- Binding `askUser` cho stdio `@lumibase/mcp-server` (backlog B208).
