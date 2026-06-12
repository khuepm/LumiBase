# Design Document — Content OS UI (Mission Control v2)

## Overview

Tái cấu trúc module `apps/studio/src/modules/mission-control/` từ "1 trang 5 tab" thành operator console điều hướng bằng URL, đồng thời đưa provenance/Content-OS ra ngoài Mission Control (item editor, AppShell). Toàn bộ là frontend; backend và SDK runtime giữ nguyên.

Hiện trạng tận dụng được:

- `missionControlApi` (`api.ts`) — 18 fetchers đủ cho mọi màn.
- `RevisionsDiff` (`modules/content/revisions-diff.tsx`) — field-level diff đã có, tái dùng làm Field_Diff.
- Pin badge + release đã có trong `item-detail.tsx` (content-os Req 8.5).
- `GET /items/:collection/:id/revisions` trả `select()` toàn bộ cột — provenance đã có trong payload, chỉ thiếu type + render.

## Architecture

### Route map (mỗi route × 2 biến thể Admin_Base)

```
/mission-control                    MissionControlLayout > DashboardPage
/mission-control/inbox              MissionControlLayout > InboxPage  (?entry=<kind>:<id>)
/mission-control/intents            MissionControlLayout > IntentsPage
/mission-control/intents/$intentId  MissionControlLayout > IntentDetailPage
/mission-control/trust              MissionControlLayout > TrustLedger (giữ nguyên)
/mission-control/constitution       MissionControlLayout > ConstitutionEditor (giữ nguyên)
```

### Component tree

```
MissionControlLayout (layout.tsx)
├─ header: title · [⏸ Kill switch] · [✨ Compose intent]
│   ├─ KillSwitchPanel (hiện có) — render trong modal
│   └─ IntentComposer (hiện có) — modal
├─ sub-nav: Overview / Inbox / Intents / Trust / Constitution  (Link, aria-current từ URL)
└─ <Outlet/>
    ├─ DashboardPage (index-page.tsx — viết lại)
    │   ├─ StatCards (use-inbox counts + intents + kill-switch)
    │   ├─ ExceptionInbox limit={5} (inbox.tsx — giữ, thêm props)
    │   └─ SloTable compact (slo-table.tsx — tách từ slo-health.tsx)
    ├─ InboxPage (inbox-page.tsx — mới)
    │   ├─ list pane: entries từ useInboxData(), chọn → ?entry=
    │   └─ detail pane:
    │       ├─ veto → StagedDiff (staged-diff.tsx — mới)
    │       ├─ approval / incident / intent_error → detail card + action
    │       └─ empty → hướng dẫn chọn entry
    ├─ IntentsPage (intents-page.tsx) = SloTable + row link detail
    └─ IntentDetailPage (intent-detail.tsx — mới)
        ├─ meta (status, schedule, autonomyCap, budget)
        ├─ RuleCards
        ├─ DriftList (link item editor)
        └─ Pause / Resume

modules/content/
├─ provenance-badge.tsx (mới) — badge human/agent + tooltip
├─ revisions-panel.tsx — thêm badge per revision + khối Provenance
└─ item-detail.tsx — badge provenance của revision mới nhất ở header

components/app-shell.tsx — badge count trên icon Mission Control
```

### Data flow

```
use-inbox.ts (mới — single source)
  useInboxData(): { entries, counts, isLoading }
    ├─ queries: mc-approvals · mc-staged · mc-autonomy · mc-intents
    │  (queryKey giữ nguyên v1 → cache share giữa Dashboard/Inbox/AppShell badge)
    ├─ buildEntries(): chuyển 4 nguồn → InboxEntry[] sắp theo urgency
    │  (chuyển từ inbox.tsx sang, thêm `id = <kind>:<sourceId>`)
    └─ counts: { total, approvals, staged, incidents, intentErrors, nearestAutoCommitAt }
```

`StagedDiff` fetch item hiện hành qua `getApiClient().items(collection).detail(itemId)`;
`before = item.data`, `after = { ...item.data, ...patch }` (shallow — khớp đơn vị diff của revision engine). Fetch lỗi → `before = null`, mọi field patch hiển thị "added" + notice.

## Design Decisions

1. **URL thay tab-state.** Tab `useState` v1 chặn deep-link và bookmark. Sub-route + search param `?entry=` cho phép notification trỏ thẳng một staged change — yêu cầu nền tảng của HOTL (content-os Req 13.2/13.6 cần deep-link diff).
2. **Kill switch là header control, không phải tab.** Nút dừng khẩn cấp phải 1 click từ mọi ngữ cảnh Mission Control (vision §4 — quyền Stop). Modal tái dùng nguyên `KillSwitchPanel`, không fork logic two-step confirm.
3. **Deep-link bằng search param thay vì route `/inbox/$id`.** Inbox entry là dữ liệu phù du (veto commit xong là biến mất) — search param cho phép graceful degrade (entry mất → vẫn ở inbox, list hiển thị bình thường) thay vì 404; cũng tránh nhân đôi thêm 2 route definitions.
4. **Tái dùng `RevisionsDiff` làm Field_Diff duy nhất.** Một renderer diff cho cả revisions panel lẫn staged change — sửa style/logic một chỗ. Không thêm thư viện diff.
5. **`before` lấy từ item hiện hành, không phải revision gốc.** Veto quyết định "thay đổi này áp lên *hiện trạng* có ổn không" — so với hiện trạng là ngữ nghĩa đúng; đồng thời lộ ra xung đột nếu item đã đổi sau khi staging tạo ra.
6. **Pause intent = kill-switch scope `intent`.** API client không có `pauseIntent` riêng; kill-switch scope `intent` chính là cơ chế pause (content-os Req 14.1). Resume dùng `resumeIntent` hiện có. Không thêm endpoint.
7. **SDK chỉ mở rộng type optional.** Backend đã trả các cột provenance (ItemService `listRevisions` dùng `select()` toàn bộ); thêm field optional vào `RevisionRow` là khai báo lại sự thật, zero runtime risk.
8. **AppShell badge dùng chung queryKey với Mission Control.** `staleTime`/`refetchInterval` 60s; khi user đang trong Mission Control, React Query dedupe — không nhân đôi request (Req 6.3).
9. **Giữ `ExceptionInbox` (v1) làm dashboard preview.** Component đã có test; thêm props `limit`/`onOpenEntry` thay vì viết lại — split-pane là màn mới bọc quanh cùng nguồn dữ liệu.
10. **Compose payload đúng contract (Req 11.1).** Composer v1 gửi `{text}` tới `/intents/compile` trong khi route validate `{description, collection}` — compile chưa từng chạy được với backend thật. v2 sửa payload và thêm collection picker; đây là lý do collection phải chọn trước khi compile (compiler cần ngữ cảnh collection cho RAG).
11. **Goal tree dựng client-side từ một trang goals.** `GET /agent/goals` trả 100 goal mới nhất không filter; cây ghép bằng map `parentGoalId`, goal mồ côi thành root (Req 12.4) để pagination không làm mất node. Khi cần scale, thêm query param phía backend — ngoài phạm vi spec này.
12. **Icon: lucide fill qua `FillIcon`** (`components/fill-icon.tsx`) — một chỗ đổi style icon cho toàn hệ; chỉ áp cho surface mới, không retrofit các module cũ trong spec này.
13. **Enrich `listPending` thay vì endpoint mới (Req 8 — bổ sung sau khi ship UI).** Phát hiện khi rà soát tích hợp: `GET /agent/staged` trả raw `agent_approvals` — không có `collection/itemId/patch` mà cả UI v1 lẫn v2 đều đọc (v1 render `?/?` với backend thật; mock test v1 mô tả một shape chưa tồn tại). Staging revision (qua `subjectId`) đã chứa đủ — một left-join trong `VetoService.listPending` đóng gap, giữ nguyên field cũ, không cần endpoint mới. Left-join để một staging hỏng không làm rỗng danh sách.

## Wireframes

### Dashboard `/mission-control`

```
┌ Mission Control ─────────────── [⏸ Kill switch] [✨ Compose intent] ┐
│ Overview · Inbox · Intents · Trust · Constitution                    │
├──────────┬───────────┬───────────┬───────────┬──────────────────────┤
│ 3 cần    │ ⏱ 42m    │ 87% SLO   │ 1 freeze  │ 2 incidents          │
│ quyết    │ veto gần  │ health    │ active    │ đang mở              │
├──────────┴───────────┴───────────┴───────────┴──────────────────────┤
│ EXCEPTIONS (5 khẩn nhất)            │ SLO HEALTH                     │
│ ⏱ Staged products/abc · 42m left   │ articles  █████░░░ 61% ⚠      │
│   [View] [Veto]                     │ products  ████████ 92%         │
│ 🛡 Approval: schema change          │ pages     ████████ 100%        │
│   [Approve] [Reject]                │                                │
│ [Open inbox →]                      │ [All intents →]                │
└─────────────────────────────────────┴────────────────────────────────┘
```

### Inbox `/mission-control/inbox?entry=veto:apr_1`

```
┌ list (trái) ──────────┬ detail (phải) ─────────────────────────────┐
│ ▶⏱ products/abc 42m   │ Staged change · products/abc      ⏱ 42m   │
│  🛡 schema change      │ 🤖 writer · [Mở item →]                    │
│  ⚠ incident eval_fail │ ┌ description  − old…   + new… ┐           │
│  ⚠ intent error       │ ├ seo_title    − …      + …    ┤           │
│                        │ └ (RevisionsDiff)              ┘           │
│                        │ Reason: [____________]  [🚫 Veto]          │
└────────────────────────┴────────────────────────────────────────────┘
```

### Intent detail `/mission-control/intents/$id`

```
┌ articles-fresh · articles · ● active ───────────── [⏸ Pause] ┐
│ schedule 0 * * * * · autonomy cap L2 co-sign · budget {…}     │
│ RULES:  [freshness ≤90d] [required: meta_description] …       │
│ DRIFTS: ⚠ open · freshness · item_123  [Mở item →]            │
│         ✓ resolved · translations:vi · item_456               │
└────────────────────────────────────────────────────────────────┘
```

## Error Handling

- Mọi query dùng pattern hiện có (loading text / error message ngắn gọn); mutation lỗi hiển thị message từ `agentFetch` (đã chuẩn hoá `errors[0].message`).
- `StagedDiff`: item 404/lỗi mạng → fallback Req 3.3, KHÔNG chặn nút Veto (veto vẫn phải hoạt động khi item không đọc được).
- Intent detail với id lạ → not-found card + link về `/mission-control/intents` (Req 5.5).
- AppShell badge: lỗi/chưa có token → ẩn badge, không retry storm (`retry: false`).

## Testing Strategy

Theo convention `mission-control.test.tsx` hiện có (mock `missionControlApi` qua `vi.hoisted`, render với QueryClientProvider; không mock router khi không cần — InboxPage/IntentDetail test qua router memory hoặc tách logic thuần):

1. **use-inbox**: unit test thuần cho `buildEntries` — thứ tự urgency (veto < approval < incident), id ổn định, counts đúng (Req 3.5, 6.1).
2. **StagedDiff**: mock items client — render diff field đổi; fetch lỗi → fallback "added" + notice (Req 3.2, 3.3).
3. **InboxPage**: chọn entry → detail hiển thị; veto gửi reason nhập vào (Req 3.1, 3.4).
4. **Provenance**: revisions panel hiển thị badge agent + khối provenance khi chọn revision agent (Req 4.2, 4.3).
5. **IntentDetailPage**: pause gọi `activateKillSwitch('intent', id, …)`, resume gọi `resumeIntent` (Req 5.4); id lạ → not-found (Req 5.5).
6. **Hồi quy**: test v1 (`mission-control.test.tsx`) giữ pass — `ExceptionInbox`, `TrustLedger`, `KillSwitchPanel`, `IntentComposer` không đổi hành vi.
