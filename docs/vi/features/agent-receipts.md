---
version: 2
lastUpdated: 2026-11-15T19:40:16.120Z
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
sourceHash: 6970ed76c5a83487
codeVerified: 2026-11-15T19:40:16.120Z
codeVerifiedHash: 6970ed76c5a83487
codeVerifiedClaims: 6
---

# Agent receipts

Agent để lại biên nhận. **Mission Control → Receipts** (`/mission-control/receipts`) cho thấy các agent có quản trị của site đã làm gì trong một cửa sổ thời gian, con người đã phải quyết định gì, tốn bao nhiêu và nội dung lệch ở đâu — để operator biết nên trao thêm hay rút bớt autonomy (#713, epic #671 A05).

## Báo cáo gồm gì

`GET /api/v1/agent/receipts?since=…&until=…` (mặc định: 30 ngày gần nhất; tối đa 180 ngày) trả về:

| Phần | Số liệu | Bảng nguồn |
|---|---|---|
| `runs` | tổng, theo status, theo agent, `failureRate` = failed / (succeeded + failed) | `agent_runs` |
| `toolCalls` | theo skill: số lần gọi, số theo kết cục, latency p50 | `agent_tool_calls` |
| `approvals` | theo status, theo người duyệt (`human` / `agent`), latency p50 / p90 / trung bình tính bằng phút (chỉ approval đã quyết) | `agent_approvals` (`kind = 'approval'`) |
| `vetoes` | cửa sổ veto: bị veto, đã commit, đang chờ, `vetoRate` | `agent_approvals` (`kind = 'veto'`) |
| `questions` | câu hỏi `askUser` đã hỏi / đã trả lời / hết hạn | `agent_approvals` (`kind = 'question'`) |
| `overrides` | con người nói không: approval bị từ chối + veto, `overrideRate` | `agent_approvals` |
| `cost` | token và USD, theo skill | `agent_tool_calls.cost` |
| `drift` | mở mới, đã xử lý, đang mở, theo rule | `content_drifts` |
| `incidents` | theo nguồn và mức độ | `agent_incidents` |
| `autonomy` | grant hiện tại, phân bố level, các lần thăng cấp, incident có capability | `agent_autonomy_grants`, `activity` (`trust_ledger.promotion_applied`) |
| `daily` | theo ngày: run, succeeded, failed, approval, incident, token, USD | các bảng trên |

Mọi số liệu được tính lúc đọc từ các bảng mà harness và trust ledger vốn đã ghi. **Không có lần ghi nào trên hot path của agent** cho báo cáo này, và không worker nào sinh ra nó.

## Cảnh báo

Ngưỡng được đặt trong trang (hoặc `PUT /api/v1/agent/receipts/alerts`) và lưu ở setting `agent.receipts.alerts`. Báo cáo liệt kê mọi ngưỡng bị vượt trong `alerts`, và trang tô đỏ ô tương ứng. Ngưỡng vắng thì không kiểm; số liệu không có dữ liệu (ví dụ chưa run nào kết thúc) không bao giờ cảnh báo. Mặc định: tỉ lệ run lỗi 0.2, tỉ lệ veto 0.25, tỉ lệ con người bác bỏ 0.3, latency approval p90 1440 phút. Dòng lưu bị hỏng thì quay về mặc định thay vì tắt mọi cảnh báo.

## Xuất CSV

`GET /api/v1/agent/receipts/export?kind=runs|tool_calls|approvals` trả một dòng cho mỗi run, tool call hoặc approval trong cửa sổ, tối đa 10.000 dòng (`X-Export-Truncated: true` khi bị cắt). Không bao giờ xuất input và output của tool. Ô văn bản bắt đầu bằng `=`, `+`, `-` hoặc `@` được thêm tiền tố `'` để bảng tính không thực thi chúng.

## Quyền truy cập

Các route nằm dưới `/api/v1/agent`, là tiền tố control plane: chỉ site administrator tới được, giống trust ledger.

## Multi-tenancy

Mọi truy vấn lọc theo `site_id` của request và theo cửa sổ; ngưỡng là setting theo site. Kiểm bằng `agent-receipts.db.integration.test.ts`, test seed cùng một fixture trên site thứ hai và khẳng định không số liệu nào bị nhân đôi.
