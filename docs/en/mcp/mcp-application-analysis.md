# Phân tích ứng dụng MCP cho 7 spec Directus-inspired

> Mục đích: nơi quay lại để quyết định **tính năng nào nên phơi bày qua MCP**, tool gì, rủi ro & ưu tiên. Dựa trên hạ tầng MCP hiện có ([`index.md`](index.md)). Đây là phân tích thiết kế, **chưa implement** — mỗi mục ghi rõ điều kiện tiên quyết (REST/service phải tồn tại trước).
>
> Nhãn nguồn: nội dung dưới đây là **[Inference]** dựa trên kiến trúc đã đọc trong codebase, không phải hành vi đã chạy.

## Nguyên tắc quyết định (áp cho mọi spec)

1. **MCP đi sau REST.** Tool MCP gọi qua `AISecureHarness`/skill hoặc gọi REST nội bộ — REST/service của feature phải tồn tại trước. Vì vậy MCP cho 7 feature này là **giai đoạn 2**, sau khi spec gốc implement xong.
2. **Permission floor bất biến.** Tool MCP không vượt quyền token. Tool mutate schema/`delete*` tự động `risk = dangerous` → qua `agent_approvals` (HITL). Tốt cho an toàn, nhưng nghĩa là tool ghi sẽ có độ trễ approval.
3. **Tiêu chí "đáng đưa lên MCP":** tác vụ (a) lặp lại/tự động hoá được, (b) agent/LLM hưởng lợi khi gọi được, (c) đọc nhiều hơn ghi (đọc an toàn, ghi cần guard). Tác vụ thuần UI (kéo-thả, picker) **không** thuộc MCP.
4. **Hai đường thêm tool:** (A) thêm vào `packages/mcp-server` (stdio, editor) — nhanh, CRUD-style; (B) đăng ký skill trong harness + `agentTools` → tự xuất hiện ở `tools/list` HTTP — đúng cho tool có risk/approval/autonomy.

---

## Bảng tổng hợp ưu tiên MCP

| Spec | Giá trị MCP | Ưu tiên MCP | Hướng | Ghi chú rủi ro |
|---|---|---|---|---|
| content-versioning | Cao | **P1** | B (harness skill) | promote = dangerous → HITL |
| insights-dashboard | Cao (read) | **P1** | A + B | run-panel read-only, an toàn; query injection đã chặn ở service |
| visual-flow-builder | Trung-cao | **P2** | B | trigger flow = side-effect; cần capability riêng |
| translation-memory-ui | Cao | **P1** | A | lookup/translate read-mostly, lý tưởng cho agent |
| image-transform-dsl | Thấp | **P3** | A (chỉ get URL) | transform là delivery, ít giá trị cho agent |
| realtime-subscriptions | Thấp/n.a. | **P3** | — | MCP là request/response, không streaming; không hợp |
| presets-inheritance | Thấp | **P3** | A | tiện ích nhỏ; chủ yếu UI state |

---

## 1. content-versioning → **P1**

**Vì sao:** agent nội dung hưởng lợi lớn khi tạo nhánh version, so sánh, và promote — đây là vòng lặp "soạn → review → xuất bản" mà agent đang làm qua revisions.

**Tool đề xuất (hướng B — harness skill, vì có ghi + HITL):**
- `version.list(collection, itemId)` — read, `safe`.
- `version.create(collection, itemId, key, name)` — write, `review_required`.
- `version.compare(collection, itemId, key)` — read, `safe`, trả `Change[]`.
- `version.promote(collection, itemId, key)` — **`dangerous`** (áp lên main) → `agent_approvals` (khớp HITL hiện có; promote đã đi qua `ItemService.update`).

**Điều kiện tiên quyết:** spec `content-versioning` (service + routes + SDK) xong.
**Rủi ro:** promote ghi đè main; bắt buộc HITL + cảnh báo `mainDiverged`. Để autonomy cap ≤ L2 cho `version.promote`.

## 2. insights-dashboard → **P1 (read-only)**

**Vì sao:** "hỏi số liệu" là use-case MCP kinh điển — agent/LLM truy vấn aggregate để trả lời câu hỏi vận hành mà không cần người mở dashboard.

**Tool đề xuất (A cho read, qua REST nội bộ):**
- `dashboard.list()`, `dashboard.getPanels(id)` — read.
- `panel.run(dashboardId, panelId, { dateRange?, filter? })` — read, trả `PanelResult`. **An toàn** vì service đã whitelist field + chống injection + filter siteId.
- (Tùy) `insights.query({ collection, aggregate, field, groupBy, filter })` — ad-hoc aggregate dùng lại `panelQuerySchema` → trả lời câu hỏi không cần panel lưu sẵn. **Đây là tool MCP có giá trị nhất của cả 7 feature** (agent tự hỏi dữ liệu).

**Điều kiện tiên quyết:** `insights-service.ts` + `panelQuerySchema` (shared) xong.
**Rủi ro:** thấp (read). Vẫn áp permission collection + giới hạn limit để tránh kéo dữ liệu lớn.

## 3. visual-flow-builder → **P2**

**Vì sao:** agent có thể kích hoạt automation theo ngữ cảnh (trigger flow), hoặc đọc lịch sử run để chẩn đoán.

**Tool đề xuất (B — vì trigger có side-effect):**
- `flow.list()`, `flow.getRuns(id)`, `flow.getRun(id, runId)` — read, `safe`.
- `flow.run(id, input)` — write/side-effect, `review_required` hoặc `dangerous` tùy flow (flow có thể http/mail/item-mutation). Cần capability `flow:trigger` riêng.

**Điều kiện tiên quyết:** spec flow gap (run history endpoint + trigger) xong.
**Rủi ro:** flow có thể gây side-effect ra ngoài (http/mail) → trigger qua MCP phải gắn capability hẹp + autonomy thấp; cân nhắc cấm `flow.run` cho token capability thấp.

## 4. translation-memory-ui → **P1**

**Vì sao:** dịch là tác vụ LLM-native; agent gọi TM lookup/translate là luồng tự nhiên. Read-mostly, ít rủi ro.

**Tool đề xuất (A — REST sẵn có):**
- `tm.lookup({ sourceLang, targetLang, text, threshold? })` — read, `safe`.
- `tm.translate({ ... })` — pipeline TM→glossary→MT; `safe` (hoặc `review_required` nếu gọi MT tốn phí).
- `tm.upsert({ ... })` — write, `review_required` (ghi vào kho TM).
- `tm.list/update/delete` — quản lý, theo risk thường.

**Điều kiện tiên quyết:** chỉ cần backend TM hiện tại (đã có!) + endpoint PATCH/DELETE từ spec `translation-memory-ui`. ⇒ **MCP cho TM có thể làm sớm nhất** vì backend đã đủ.
**Rủi ro:** thấp; `tm.translate` có thể tốn phí MT → rate limit.

## 5. image-transform-dsl → **P3**

**Vì sao:** transform là delivery (ảnh ra trình duyệt), agent ít hưởng lợi. Giá trị MCP chủ yếu là **lấy URL transform** để chèn vào nội dung.

**Tool đề xuất (A, nhỏ):**
- `media.url(key, { preset | dsl })` — trả URL đã ký (nếu bật signed). Read, `safe`.
- `transformPreset.list()` — read.

**Điều kiện tiên quyết:** spec `image-transform-dsl` xong.
**Rủi ро:** thấp; không expose transform compute qua MCP (vô nghĩa).

## 6. realtime-subscriptions → **P3 / không hợp**

**Vì sao:** MCP HTTP endpoint là **request/response một-lần**, không có server-initiated stream (SSE đã tắt). Realtime/subscription **không map** vào mô hình này.

**Kết luận:** **không đưa subscription lên MCP.** Nếu cần "agent biết item mới đổi", dùng tool **poll** `items.listSince(collection, since)` (read) thay vì subscribe. Ghi nhận để không lãng phí công.
**Tương lai:** nếu MCP spec/triển khai hỗ trợ streaming notifications ổn định, xem lại.

## 7. presets-inheritance → **P3**

**Vì sao:** preset là UI view-state; ít giá trị cho agent. Có thể hữu ích để agent "mở collection theo view chuẩn của role".

**Tool đề xuất (A, tùy chọn):**
- `preset.effective(collection)` — read, trả view mặc định. `safe`.

**Điều kiện tiên quyết:** spec `presets-inheritance` xong.
**Rủi ро:** thấp.

---

## Lộ trình MCP đề xuất (sau khi spec gốc implement)

1. **Sóng 1 (giá trị cao, rủi ro thấp, read-first):**
   - `insights.query` / `panel.run` (read aggregate — tool MCP giá trị nhất).
   - `tm.lookup` / `tm.translate` (có thể làm sớm — backend TM đã sẵn).
2. **Sóng 2 (ghi có guard):**
   - `version.*` (promote qua HITL).
   - `tm.upsert`.
3. **Sóng 3 (side-effect, cẩn trọng):**
   - `flow.run` (capability hẹp + autonomy thấp).
4. **Bỏ qua / theo dõi:** realtime (không hợp request/response), image transform (chỉ `media.url`), presets (`preset.effective` tùy chọn).

## Điều kiện chung trước khi mở bất kỳ tool MCP ghi nào

- Tool ghi → `riskPolicy.level` đúng (`review_required`/`dangerous`) để vào `agent_approvals`.
- `rateLimit` đặt cho tool gọi LLM/MT hoặc tốn tài nguyên (`tm.translate`, `insights.query` nặng).
- Test parity: thêm case vào `mcp-parity.property.test.ts` đảm bảo quyết định MCP == harness.
- Cập nhật [`index.md`](index.md) bảng tool khi tool mới xuất hiện ở `tools/list`.
