# LumiBase AI-Native Vision — Tái định nghĩa CMS cho kỷ nguyên AI

> **Trạng thái:** Proposal / định hướng sản phẩm. Tài liệu này mô tả tầm nhìn và kế hoạch — chưa phải hành vi hiện tại của hệ thống. Hiện trạng đã triển khai được đánh dấu rõ ở mục [Gap analysis](#5-gap-analysis--hiện-trạng-so-với-đích).
>
> **Tiền đề kỹ thuật:** [agent-harness-layer.md](./features/agent-harness-layer.md) · [ai-copilot.md](./features/ai-copilot.md) · [flows-automation.md](./features/flows-automation.md) · [ADR-003 HITL](./architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md)

---

## 1. Luận điểm trung tâm

**CMS truyền thống là công cụ để con người thao tác trên nội dung. LumiBase là hệ điều hành để AI vận hành nội dung — con người giữ vai trò đặt ý định, định gu, và chịu trách nhiệm cuối.**

Tên gọi mới cho phạm trù: **Content Operating System (Content OS)** — không còn là *Content Management System*.

Ba sự dịch chuyển nền tảng:

| | CMS truyền thống | LumiBase Content OS |
|---|---|---|
| **Đơn vị công việc** | Thao tác (create item, edit field, publish) | **Ý định** (goal: "duy trì catalog luôn đủ ảnh + mô tả 2 ngôn ngữ") |
| **Người vận hành** | Editor/admin thao tác qua UI | **Agent** thực thi trong harness; con người duyệt ngoại lệ |
| **Trạng thái nội dung** | Tĩnh — đúng tại thời điểm ai đó sửa lần cuối | **Sống** — được reconcile liên tục về desired state |

"Thay thế con người" ở đây có nghĩa chính xác: **thay thế lao động vận hành** (data entry, dịch, tagging, SEO chỉnh tay, dọn dữ liệu, viết mô tả). Con người dịch chuyển lên tầng trên: intent, taste, policy, accountability. Đây không phải khẩu hiệu an toàn — đây là thiết kế: hệ thống chỉ tự trị được khi trách nhiệm có địa chỉ và mọi hành động revert được.

---

## 2. Bảy nguyên lý thiết kế (Deep principles)

### P1. Intent thay cho thao tác (Intent-driven, not operation-driven)

API bậc nhất của CMS không còn là `POST /items` mà là `POST /agent/goals`. Một goal là một câu khai báo kết quả mong muốn + ràng buộc + budget. Harness phân rã goal thành plan, plan thành tool calls. `agent_goals` đã tồn tại — nguyên lý này nâng nó từ "log của copilot" thành **giao diện vận hành chính** của sản phẩm.

Hệ quả thiết kế: mọi tính năng mới phải trả lời "agent gọi nó thế nào?" trước khi trả lời "UI hiển thị nó thế nào?". UI là projection của agent surface, không phải ngược lại.

### P2. Desired state & reconciliation (học từ Kubernetes, áp vào nội dung)

Nội dung có **SLO** khai báo được: *"mọi `product` published phải có ≥1 ảnh, mô tả 50–200 từ, bản dịch `vi`+`en`, không broken link, cập nhật giá trong 24h"*. Một **reconciliation loop** chạy định kỳ: phát hiện drift → sinh goal → agent sửa trong budget → ghi artifact + provenance. Con người không "quản lý nội dung"; con người **khai báo trạng thái mong muốn** và hệ tự hội tụ về đó.

Đây là điểm tái định nghĩa sâu nhất: CMS hiện tại là *write-time tool*; Content OS là *control loop* — nội dung sai SLO là một sự cố được tự xử lý, như pod crash được restart.

### P3. Trust gradient — autonomy là thứ kiếm được, không phải cấp phát

HITL nhị phân (safe → chạy, dangerous → chờ duyệt) là đúng cho ngày đầu nhưng không scale: con người thành nút cổ chai và "approve mỏi tay" làm việc duyệt mất giá trị. Thay bằng **5 mức tự trị per (site, agent, capability)**:

| Mức | Tên | Hành vi |
|---|---|---|
| **L0** | Shadow | Agent chạy, output chỉ ghi vào artifact — không đề xuất, không tác động. Dùng để đánh giá. |
| **L1** | Propose | Mọi hành động tạo approval chờ duyệt (HITL toàn phần). |
| **L2** | Co-sign | Safe action tự chạy, dangerous action chờ duyệt. *(= hành vi harness hiện tại)* |
| **L3** | Veto-window | Dangerous action **tự thực thi vào revision staging, commit sau T giờ nếu không ai veto**. Con người chuyển từ pre-approval sang post-veto (HOTL — human-on-the-loop). |
| **L4** | Autopilot | Tự thực thi trong phạm vi capability + budget; kill switch luôn sẵn. |

**Promotion là dữ liệu, không phải cảm tính:** lên mức khi đạt N runs liên tiếp pass evaluation + approval-rate ≥ ngưỡng + zero incident trong window. **Demotion tự động** khi có incident, rejection, hoặc evaluation fail. Toàn bộ là một *trust ledger* audit được — chính `agent_evaluations` + `agent_approvals` hiện có là nguồn dữ liệu.

L3 (veto-window) là phát kiến quan trọng nhất của thang này: nó đảo chiều gánh nặng — im lặng nghĩa là đồng ý — nhưng vẫn giữ quyền phủ quyết tuyệt đối và rollback. Đa số tổ chức sẽ sống lâu dài ở L3, không phải L4.

### P4. Hiến pháp nội dung (Tenant Constitution) — gu biên tập trở thành máy-kiểm-được

Cái con người giỏi nhất — brand voice, tông giọng, ranh giới pháp lý, taxonomy, "thế nào là bài tốt" — phải được mã hoá thành **constitution per tenant**: tập evaluator (rule DSL + LLM-judge prompt) có version, có hash. Mọi `agent_run` pin vào `constitutionHash` (mở rộng `policySnapshotHash` hiện có). Artifact không pass constitution thì không được publish, bất kể autonomy level.

Hệ quả: "biên tập viên" trong kỷ nguyên AI là người **viết và tinh chỉnh hiến pháp**, không phải người sửa từng bài. Sửa một evaluator = sửa hành vi của mọi agent từ đó về sau — đòn bẩy 1→N thay vì 1→1.

### P5. Provenance-first — mọi byte nội dung có lai lịch

Trong kỷ nguyên nội dung do máy sinh, **lai lịch là tính năng phân phối, không phải metadata phụ**. Mọi revision ghi: agent/run/model tạo ra nó, nguồn tham chiếu, constitution hash, evaluation kết quả, con người nào duyệt (nếu có), confidence. Provenance expose qua Delivery API (lấy cảm hứng C2PA) — site downstream chứng minh được nội dung của họ sạch. Đây là USP thương mại: CMS khác không trả lời được câu hỏi *"đoạn văn này từ đâu ra và ai chịu trách nhiệm?"*.

### P6. Toà soạn agent (multi-agent organization, không phải one-big-agent)

Một agent vạn năng là anti-pattern: context phình, trách nhiệm nhoè, eval không cô lập được lỗi. Thay vào đó là **sơ đồ tổ chức của agent** — mô phỏng toà soạn:

```
                    ┌────────────────────┐
   intent ───────► │  Planner / Chief    │  phân rã goal → sub-goals
                    └─────┬──────────────┘
        ┌────────────┬────┴───────┬─────────────┐
        ▼            ▼            ▼             ▼
   Writer        Translator   Taxonomist     SEO agent
   (items:write) (items:write)(schema:read)  (items:update)
        │            │            │             │
        └────────────┴─────┬──────┴─────────────┘
                           ▼
                    ┌────────────────────┐
                    │  Reviewer / Fact-  │  agent-as-reviewer cho rủi ro thấp,
                    │  checker agent     │  escalate con người cho rủi ro cao
                    └────────────────────┘
```

Cơ chế: sub-goal là `agent_goals` có `parentGoalId`; mỗi role agent có capability grant hẹp riêng trong `agent_permissions`; **review chéo giữa agent** là một loại approval (approver là agent có capability `review:*`) — con người chỉ nhận escalation. Phân quyền hẹp per-role chính là defense-in-depth: Writer không bao giờ có `schema:*`, nên một writer bị prompt-inject cũng không sửa được schema.

### P7. Giao diện kép — Studio là Mission Control, API/MCP là cửa chính

- **Cho agent (cửa chính):** toàn bộ skill registry expose như **MCP server** chuẩn, để agent bên ngoài (Claude Code, agent của khách hàng) thao tác CMS như citizen hạng nhất, vẫn đi qua harness/capability/risk như agent nội bộ. Kèm `llms.txt` per site cho content delivery — vì **người tiêu thụ nội dung cũng ngày càng là agent**.
- **Cho người (cửa giám sát):** Studio tiến hoá từ *editing surface* thành *mission control*: exception inbox, diff review, trust ledger, kill switch, constitution editor. Form sửa item vẫn còn, nhưng là lối thoát hiểm, không phải workflow chính.

---

## 3. Mô hình vận hành đích (một ngày của Content OS)

```
06:00  Reconciler quét SLO: 14 product thiếu bản dịch vi, 3 bài blog stale,
       2 broken links → sinh 3 goals, gán cho Translator/Writer/Librarian agents.
06:05  Translator agent (L4) dịch 14 mô tả, eval pass constitution → publish thẳng,
       provenance ghi đầy đủ.
06:10  Writer agent (L3) viết lại 3 bài stale → commit vào staging revision,
       veto window 4h, notify kênh #content.
08:30  Biên tập viên mở mission control: thấy 3 diff chờ veto — đọc lướt, veto 1 bài
       (sai tông), 2 bài còn lại tự commit lúc 10:10. Bài bị veto → demotion signal
       cho Writer agent trên capability đó.
09:00  Khách hàng gõ vào chat: "tháng sau ra dòng sản phẩm mới, chuẩn bị landing page"
       → goal mới → Planner phân rã: schema diff (cần approve - L2), page spec,
       seed content, SEO plan → artifacts chờ review.
```

Con người trong bức tranh này làm 3 việc: **đặt intent**, **veto/duyệt ngoại lệ**, **tinh chỉnh hiến pháp**. Không ai gõ form `create item` cả ngày nữa.

---

## 4. Kiến trúc đích

```
┌─────────────────────────────────────────────────────────────────┐
│  INTENT LAYER          goals · SLO/desired-state · constitution │
├─────────────────────────────────────────────────────────────────┤
│  ORCHESTRATION LAYER   planner · multi-agent delegation ·       │
│                        reconciliation loops (Flows + queue)     │
├─────────────────────────────────────────────────────────────────┤
│  HARNESS LAYER (đã có) runs · tools · capability check · risk · │
│                        budget · approvals · artifacts · evals ·  │
│                        memory                  + autonomy ledger │
├─────────────────────────────────────────────────────────────────┤
│  TRUST LAYER           provenance · trust ledger · veto window · │
│                        kill switch · incident → demotion         │
├─────────────────────────────────────────────────────────────────┤
│  DATA LAYER (đã có)    collections · items · revisions · RLS ·  │
│                        multi-tenant · embeddings                 │
├─────────────────────────────────────────────────────────────────┤
│  SURFACES              MCP server · Agent API · Delivery API +   │
│                        llms.txt │ Studio Mission Control          │
└─────────────────────────────────────────────────────────────────┘
```

Bất biến kế thừa nguyên vẹn từ harness hiện tại (không thương lượng):

1. Prompt text không bao giờ cấp được capability — chỉ policy snapshot và grant.
2. Mọi bảng agent scope theo `siteId`.
3. Mọi hành động tự trị phải revert được (revisions) — hành động không revert được (hard delete, gửi email ra ngoài) không bao giờ vượt quá L2.
4. Budget (tool calls, cost, time, artifact size) chặn cứng mọi run.
5. Audit không bị ghi đè — retry là run mới link run cũ.

---

## 5. Gap analysis — hiện trạng so với đích

Đã có (theo docs + code trong `apps/cms/src/services/`):

- ✅ Harness đầy đủ: `agent_goals/runs/plans/tools/permissions/tool_calls/approvals/artifacts/evaluations/memory`, budget, risk policy, audit, metrics, dead-letter queue.
- ✅ HITL 2 mức (= L1/L2 của thang autonomy), capability check, policy snapshot hash.
- ✅ LLM provider đa nhà cung cấp + embedding service + RAG skills.
- ✅ Flows engine (trigger webhook/event/schedule/manual) — nền cho reconciler.
- ✅ Artifact-first app generation MVP + evaluation gates.

Chưa có (khoảng cách):

- ❌ 5/14 core skills còn **stub** (`aiSuggestField`, `aiContentAssist`, `generateAppSpec`, `generateApiDocs`, `generateSeedData`) — chưa nối LLM thật.
- ❌ Không có khái niệm SLO/desired-state cho content; không có reconciliation loop.
- ❌ Autonomy nhị phân, không có trust ledger, không có veto-window, không có promotion/demotion.
- ❌ Không có constitution per tenant (evaluation mới ở mức schema validation / spec lint / prompt safety).
- ❌ Không có provenance trên item revisions.
- ❌ Không có multi-agent delegation (`parentGoalId`, role agents, agent-as-reviewer).
- ❌ Không có MCP server; agent ngoài chưa thao tác CMS được theo chuẩn.
- ❌ Run dài hơn request limit chưa chạy được (chưa đẩy qua queue/workflow).
- ❌ Studio vẫn là editing surface; chưa có mission control / exception inbox.

---

## 6. Lộ trình 5 phase

Mỗi phase ship được độc lập, phase sau xây trên phase trước. Quy ước nhãn theo [roadmap/tasks.md](./roadmap/tasks.md).

### Phase A — Thật hoá nền móng (Make it real)

*Mục tiêu: không còn stub; agent ngoài kết nối được; run dài chạy được.*

- `[BE]` Nối 5 stub skills vào LLM provider thật + embedding context (RAG từ items/schema hiện có).
- `[BE]` Đẩy run vượt request-limit qua `QueueProvider` (đã có abstraction) — run state machine: `queued → running → awaiting_approval → done/failed`.
- `[BE]` **MCP server** mount tại `/api/v1/mcp`: expose `agent_tools` registry như MCP tools; auth = token có capability; mọi call đi qua harness y như nội bộ. *(Một codepath, hai cửa.)*
- `[BE]` `llms.txt` + semantic delivery per site cho content consumer là agent.
- `[DB]` Cột provenance trên revisions: `createdByRunId`, `model`, `constitutionHash`, `sources jsonb`, `confidence`.

### Phase B — Content như hệ thống sống (Reconciliation)

*Mục tiêu: nội dung tự hội tụ về desired state.*

- `[DB]` Bảng `content_intents` (SLO): `siteId, collection, rules jsonb, schedule, budget, autonomyCap, status`.
- `[BE]` **Drift detectors** (chạy như Flows scheduled): stale content, thiếu field bắt buộc theo SLO, thiếu bản dịch (tận dụng translation memory), broken link, SEO score, lệch glossary.
- `[BE]` Reconciler: drift → `agent_goals` tự sinh (idempotent, dedupe theo drift fingerprint) → harness thực thi trong `autonomyCap` của intent.
- `[FE]` Studio: màn hình SLO — khai báo intent bằng natural language, LLM compile thành rules jsonb, hiển thị "content health" per collection.

### Phase C — Toà soạn agent (Multi-agent org)

*Mục tiêu: phân rã và review chéo giữa agent; con người chỉ nhận escalation.*

- `[DB]` `agent_goals.parentGoalId`; bảng `agent_roles` (name, systemPrompt ref, capability grants, model).
- `[BE]` Planner agent: goal → sub-goals gán theo role; mỗi role chạy capability hẹp riêng (Writer không bao giờ có `schema:*`).
- `[BE]` Agent-as-reviewer: approval có `approverType: human | agent`; rủi ro thấp do Reviewer agent (capability `review:*`) quyết, kèm lý do ghi audit; rủi ro cao escalate người. Ngưỡng escalation là policy, không hardcode.
- `[AI]` Role library mặc định: Writer, Translator, Taxonomist, SEO, Fact-checker, Librarian (archive/cleanup).

### Phase D — Autonomy kiếm được (Trust ledger)

*Mục tiêu: thang L0–L4 vận hành bằng dữ liệu.*

- `[DB]` Bảng `agent_autonomy_grants`: `siteId, agentRole, capability, level (0-4), evidence jsonb, grantedBy, expiresAt`. Bảng `agent_incidents`: nguồn demotion.
- `[BE]` Promotion engine: tính từ `agent_evaluations` + `agent_approvals` + incident history; promotion cần con người xác nhận (chính nó là một approval), **demotion thì tự động và tức thì**.
- `[BE]` **Veto window (L3)**: dangerous op ghi vào staging revision + `agent_approvals` dạng `auto_commit_at`; commit job qua queue; veto = reject + auto-rollback + incident.
- `[BE]` Kill switch per site/per role: `agent_runtime: active | paused | frozen` — frozen chặn cả run đang chạy ở tool-call boundary.
- `[FE]` Trust ledger UI: level hiện tại, evidence, lịch sử promote/demote per role × capability.

### Phase E — Đảo ngược giao diện (Mission Control)

*Mục tiêu: Studio mặc định là giám sát, không phải nhập liệu.*

- `[FE]` **Exception inbox** thành màn hình mặc định: veto queue (diff view), escalations, incidents, SLO violations chưa tự xử được.
- `[FE]` **Constitution editor**: viết/edit evaluator bằng natural language + test chạy thử trên content thật (eval-driven editing); version + diff hiến pháp.
- `[FE]` Intent composer: thay "Create item" bằng "Describe what you want" làm primary CTA; form editing vẫn còn như secondary path.
- `[DOC]` Tái định vị messaging: LumiBase = Content OS; cập nhật [vision-and-positioning.md](./vision-and-positioning.md).

---

## 7. North-star metrics

| Metric | Định nghĩa | Đích trưởng thành |
|---|---|---|
| **Autonomous operation rate** | % thao tác ghi do agent thực thi không cần human touch | > 90% |
| **Human-touch per published item** | Số tương tác người / item publish | < 0.1 |
| **Intent-to-live latency** | Từ lúc đặt goal đến nội dung live | Phút, không phải ngày |
| **Veto rate (L3)** | % staging commit bị veto | < 5% và giảm dần |
| **Incident rate** | Sự cố / 1.000 autonomous ops | Giảm đơn điệu theo thời gian |
| **Constitution leverage** | Số hành vi agent thay đổi / 1 lần sửa evaluator | Tăng |

Toàn bộ đo được từ bảng harness hiện có + Prometheus metrics đã mô tả trong [observability.md](./features/observability.md).

---

## 8. Rủi ro & guardrails

| Rủi ro | Guardrail |
|---|---|
| Prompt injection từ content/web khiến agent leo thang | Bất biến #1 (prompt không cấp quyền) + capability hẹp per role + outbound URL guard/SSRF guard đã có |
| Drift chất lượng âm thầm ở L4 | Sampling: x% output L4 luôn rơi về human review; constitution eval chạy trên mọi publish |
| Approve-mỏi-tay làm review vô nghĩa | Chính là lý do tồn tại của L3 veto-window + agent-as-reviewer — giảm khối lượng review của người xuống chỉ còn ngoại lệ |
| Vòng lặp reconcile chạy điên (goal storm) | Dedupe theo drift fingerprint + budget per intent + circuit breaker (N fail liên tiếp → pause intent + incident) |
| Hành động không revert được | Không bao giờ vượt L2; hard delete vẫn là soft delete + retention như hiện tại |
| Mất niềm tin của khách | Provenance public + audit trail đầy đủ + kill switch một nút |

---

## 9. Tóm tắt một đoạn

LumiBase đã có bộ xương đúng: harness quản trị agent với goals, runs, tools, approvals, artifacts, evaluations, memory. Kế hoạch này biến bộ xương thành cơ thể sống theo 5 bước: **(A)** thật hoá skill + mở MCP, **(B)** biến nội dung thành hệ thống tự hội tụ qua SLO + reconciliation, **(C)** tổ chức agent thành toà soạn có phân vai và review chéo, **(D)** thay HITL nhị phân bằng thang tự trị kiếm-được với veto-window, **(E)** đảo Studio thành mission control. Kết quả là một phạm trù sản phẩm mới — **Content Operating System** — nơi AI là lực lượng vận hành chính, còn con người làm ba việc máy chưa thay được: đặt ý định, định gu, và chịu trách nhiệm.
