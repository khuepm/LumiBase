---
version: 3
sourceLang: en
translatedFrom: en
mtEngine: manual
syncStatus: human-translated
lastUpdated: 2026-10-14T16:17:50.688Z
sourceHash: 84389437c23c0c9c
codeVerified: 2026-10-14T16:17:50.688Z
codeVerifiedHash: 84389437c23c0c9c
codeVerifiedClaims: 30
---

# Pilot kiểm tra bản nháp (Jev)

Pilot kiểm chứng xem [kiểm tra bản nháp](./draft-review.md) có giúp biên tập viên làm nhanh hơn mà không khiến họ chấp nhận gợi ý sai hay không, trước khi bật bất kỳ tự động hoá nào. Pilot chạy theo từng site, trên các bộ sưu tập do site admin chọn, qua hai giai đoạn: **baseline** (panel kiểm tra bị ẩn, chỉ đo thời gian biên tập) và **assisted** (panel được hiện).

**Trạng thái: chưa có kết quả đo.** Endpoint số liệu, báo cáo và các nút điều khiển đã có; chưa có pilot thật nào chạy. Báo cáo đã commit `apps/cms/eval/jev-pilot/reports/jev-pilot-v1.template.md` là một mẫu rỗng, và chưa có quyết định go/no-go. Mở kiểm tra bản nháp rộng hơn phạm vi pilot, hoặc bật tự động hoá, là một quyết định riêng cần phê duyệt riêng.

Code: `apps/cms/src/services/review-metrics.ts`, `apps/cms/src/routes/ai-review.ts`, `apps/cms/eval/jev-pilot/report.ts`, `apps/cms/scripts/jev-pilot-report.ts`, `apps/studio/src/modules/settings/ai-decisions-settings.tsx`, `apps/studio/src/modules/content/use-review-pilot.ts`.

## Protocol đăng ký trước (`jev-pilot-v1`)

Các tiêu chí, số mẫu tối thiểu và sai số chấp nhận dưới đây được chốt **trước** khi thu dữ liệu. Chúng được đánh phiên bản trong code là `PILOT_PROTOCOL` ở `review-metrics.ts`. Đổi bất kỳ giá trị nào nghĩa là một phiên bản protocol mới và một pilot mới, không phải đọc lại cùng dữ liệu theo cách khác. Báo cáo từ chối số liệu của phiên bản protocol khác.

**Số mẫu tối thiểu.** Dưới các mức này, kết quả vẫn được báo nhưng gắn cờ `insufficientSample`, và không thể đạt.

| Mẫu | Tối thiểu |
|---|---|
| Phiên kiểm tra thật cho mỗi chế độ (baseline và assisted, mỗi chế độ) | 100 |
| Gợi ý đã được xem | 100 |
| Run đã hoàn tất | 100 |
| Mỗi nhóm tách (locale, provider, phiên bản profile) | 30 |
| Gợi ý được người đối chiếu (adjudicator) kiểm tra | 50 |

**Sai số chấp nhận.** Một tỷ lệ chỉ được coi là kết luận được khi khoảng Wilson 95% của nó có nửa độ rộng tối đa 0,10. Một tỷ lệ chỉ đạt khi toàn bộ khoảng nằm đúng phía của ngưỡng. Khi giá trị điểm thoả ngưỡng nhưng khoảng thì không, trạng thái là `inconclusive`. `time_reduction` và `latency_p95` không có khoảng tin cậy: chúng đạt hay trượt dựa trên một giá trị điểm (tỷ lệ giữa hai trung vị, và p95). Hãy coi một tỷ lệ `time_reduction` sát mức 0,80 là chưa phân định, không phải đạt hay trượt rõ ràng. Thêm khoảng tin cậy sẽ là một phiên bản protocol mới.

**Tiêu chí thành công.** Phải đạt tất cả.

| Tiêu chí | Đạt khi |
|---|---|
| `time_reduction` | trung vị thời gian mỗi item ở assisted ≤ 0,80 × trung vị baseline |
| `rejection_rate` | cận trên 95% của tỷ lệ reject trên gợi ý đã xem ≤ 0,30 |
| `coverage` | cận dưới 95% của tỷ lệ run hoàn tất không abstain ≥ 0,80 |
| `error_rate` | cận trên 95% của tỷ lệ run kết thúc bằng lỗi ≤ 0,10 |
| `latency_p95` | latency p95 của provider trên run hoàn tất ≤ 10.000 ms |
| `adjudicated_error_rate` | cận trên 95% của tỷ lệ gợi ý bị người đối chiếu đánh giá là sai ≤ 0,10 (chỉ có trong báo cáo) |

**Quyết định.** `go` chỉ khi mọi tiêu chí đều đạt, kể cả đối chiếu. `no_go` khi có tiêu chí trượt trên mẫu đủ lớn. Còn lại là `insufficient_data`: mẫu quá nhỏ, khoảng tin cậy vắt qua ngưỡng, chưa ghi đối chiếu, hoặc số liệu bị cắt bớt. `go` là khuyến nghị cho người phê duyệt bước tiếp theo, không phải rollout tự động.

## Đo gì

- **Phiên (session).** Một phiên biên tập chạy từ lúc mở trình soạn thảo (mục đã lưu hoặc form mục mới) tới lần lưu thành công đầu tiên, trên một bộ sưu tập trong pilot. Các lần lưu sau trong cùng trình soạn thảo đang mở không phải phiên mới. Phiên dài hơn hai giờ được coi là bỏ dở: bị loại khỏi số liệu thời gian và báo trong `idleSessionsExcluded`.
- **Thời gian mỗi item.** p50, p95 và trung bình của thời lượng phiên, tách baseline và assisted, cùng tỷ lệ giữa hai trung vị.
- **Chỉ tính biên tập viên.** Chỉ người dùng đã đăng nhập được tính. `POST /api/v1/ai/reviews/sessions` từ chối API key và dev principal với `403 FORBIDDEN`. Số liệu cũng bỏ mọi phiên hay phán quyết không đến từ người dùng, nên một integration key chạy và chấp nhận kiểm tra không cộng thêm thời gian biên tập hay gợi ý đã xem nào.
- **Gợi ý đã được xem.** Các gợi ý của một run mà Studio đã hiển thị cho biên tập viên trong phiên assisted (`viewedQuestions`). Tỷ lệ accept, edit, reject và không phản hồi chỉ tính trên gợi ý đã được xem, và chỉ phán quyết của chính người đã xem được tính. Feedback gửi mà không có phiên xem, ví dụ gửi thẳng qua API, không được tính.
- **Vận hành.** Coverage (run hoàn tất không abstain), abstention, tỷ lệ lỗi, latency p50/p95, và token mỗi run khi provider báo đủ cả hai số.
- **Tách nhóm.** Theo locale của nội dung, theo provider và theo phiên bản profile (`key@vN`), mỗi nhóm có số mẫu và cờ riêng.
- **Độ tập trung của mẫu.** `sampleCounts.distinctEditors` và `sampleCounts.distinctItems` cho biết số biên tập viên và số item khác nhau đứng sau các phiên của mỗi chế độ. Mỗi form mục mới được tính là một item riêng. Mức tối thiểu đếm theo phiên, nên hãy xem các số này trước khi coi một mức tối thiểu là đã đạt.

Số lượt gọi API và số run không bao giờ được báo như giá trị người dùng. Chúng chỉ là mẫu số cho coverage, lỗi và latency.

## Thiết lập

1. **Hồ sơ.** Site admin tạo một hồ sơ kiểm tra cho bộ sưu tập (`POST /api/v1/ai/review-profiles`, xem [kiểm tra bản nháp](./draft-review.md)).
2. **Người tham gia.** Cấp capability `ai:decide` cho các biên tập viên trong pilot (quyền `create` trên permission collection `lumibase_ai_decisions`). Biên tập viên không có quyền này thấy trình soạn thảo thường và không ghi phiên nào.
3. **Baseline.** Trong Studio, **Settings → AI decisions**: bật **Run the draft-review pilot**, chọn các bộ sưu tập (tối đa 100) và giữ chế độ **Baseline**. Giai đoạn này không gửi nội dung đi đâu, nên site chưa cần opt-in với provider. Thu ít nhất 100 phiên.
4. **Assisted.** Bật **Send content to the decision provider**, đổi chế độ sang **Assisted** rồi lưu. Thu ít nhất 100 phiên assisted. Giữ nguyên bộ sưu tập, biên tập viên và loại công việc như ở baseline.
5. **Đối chiếu.** Một người không phải tác giả nội dung kiểm tra một mẫu ngẫu nhiên ít nhất 50 gợi ý đã được xem và ghi `{ "sampled": 50, "errors": 3, "adjudicators": 1 }` vào một file JSON. Hệ thống không tự thu dữ liệu này.
6. **Báo cáo.** Site admin xuất số liệu và tạo báo cáo:

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  "$CMS/api/v1/ai/reviews/metrics?from=2026-11-01&to=2026-12-01" > metrics.json
pnpm -F @lumibase/cms pilot:report -- --metrics metrics.json --adjudication adjudication.json
```

Báo cáo được ghi vào `apps/cms/eval/jev-pilot/reports/` dưới dạng JSON và Markdown, kèm phiên bản protocol, số mẫu, từng tiêu chí với trạng thái, quyết định và các giới hạn. `pnpm -F @lumibase/cms pilot:report -- --template` ghi ra mẫu rỗng.

## Quyền

| Thao tác | Cần |
|---|---|
| Đổi pilot hoặc kill switch (`POST /api/v1/settings`, key `aiDecisions`) | site admin |
| Đọc chế độ pilot, chạy kiểm tra, gửi feedback | `ai:decide` |
| Ghi phiên | `ai:decide`, với tư cách người dùng đã đăng nhập (không phải API key) |
| Đọc số liệu (`GET /api/v1/ai/reviews/metrics`) | site admin |

## Dữ liệu gửi tới provider

- **Baseline:** không gì cả.
- **Assisted:** chỉ các trường mà hồ sơ kiểm tra liệt kê, đọc theo quyền dòng và quyền trường của chính biên tập viên, cộng các câu hỏi của hồ sơ. Khoá provider nằm trên CMS.
- **LumiBase lưu:** run (câu trả lời và provenance, không lưu nội dung), phán quyết feedback, và phiên (thời lượng, chế độ, locale, id run và key các câu hỏi đã xem, không có nội dung). Run và feedback của nó bị xoá sau `DECISION_REVIEW_RETENTION_DAYS` (mặc định 180). Việc xoá giữ lại phiên và bỏ tham chiếu tới run.

## Trạng thái chưa chắc chắn

- **Chưa đủ thông tin** trong trình soạn thảo: run đã abstain. Gợi ý vẫn hiện, nhưng không thể chấp nhận giá trị cho trường.
- **`insufficient_sample`** trong số liệu và báo cáo: dưới mức tối thiểu đăng ký trước. Không phải kết quả.
- **`inconclusive`**: đủ dữ liệu, nhưng khoảng tin cậy vắt qua ngưỡng. Không phải đạt.
- Xác suất của provider không phải xác suất đúng, trừ khi provider được hiệu chỉnh trên chính dữ liệu này. Trình soạn thảo hiển thị nhãn `calibrated` do chính provider tự khai.

## Rollback và tắt

- **Kill switch.** **Settings → AI decisions → Turn everything off** đặt `aiDecisions.enabled` và `aiDecisions.review.enabled` về `false` trong một lần ghi. Danh sách bộ sưu tập và chế độ đã lưu được giữ lại, nên bật lại pilot chỉ cần một bước. Các chỉnh sửa chưa lưu trên trang bị bỏ, không được lưu.
- **Cách tương đương qua API.** Đọc giá trị hiện tại bằng `GET /api/v1/settings/aiDecisions`, rồi `POST /api/v1/settings` với `{ "key": "aiDecisions", "value": { ...current, "enabled": false, "review": { ...current.review, "enabled": false } } }`.
- **Hệ quả.** Panel biến mất và trình soạn thảo hoạt động như trước. `POST /api/v1/ai/reviews`, feedback mới và phiên mới trả `403 DECISION_DISABLED`. Request đang chạy dở trong Studio thất bại với cùng mã.
- **Không xoá gì.** Bản nháp, item, run, feedback, phiên và audit event đều còn. Lịch sử run (`GET /api/v1/ai/reviews?collection=&itemId=`, `GET /api/v1/ai/reviews/:id`) và số liệu vẫn đọc được.
- **Rollback phiên bản.** Migration `0020_jev_review_sessions` chỉ thêm một bảng. Rollback CMS thì bảng đó chỉ đơn giản không được dùng.

## Đa tenant

- **Cô lập theo tenant:** setting `aiDecisions`, phiên, run, feedback và số liệu. Mọi truy vấn lọc theo `site_id`, và `lumibase_review_sessions` có trong `rls-policies.sql`.
- **Dùng chung:** thông tin xác thực của provider và trần quota toàn deployment (không đổi so với [API decision](../api/hono-api-spec.md#8-ai-copilot)).
- **Được kiểm bởi:** `apps/cms/src/routes/__tests__/ai-review.test.ts` (chặn theo pilot, RBAC của phiên, từ chối run của site khác, số liệu chỉ đếm site của người gọi) và `apps/cms/src/services/__tests__/review-sessions.db.integration.test.ts` (số liệu theo site trên Postgres; tắt pilot hoặc kill switch giữ mọi dòng).

## Shell desktop và mobile

Các lời gọi rollout và phiên đi qua `getApiClient()`, nên dùng `getApiBaseUrl()` và token store giống phần còn lại của Studio.

## Giới hạn

- Phiên chỉ thấy thời gian trong trình soạn thảo. Thời gian tra cứu hay làm việc ở nơi khác không được đo.
- Baseline và assisted được so sánh theo nhóm, không ghép cặp theo item hay biên tập viên. Hãy giữ ổn định biên tập viên và loại công việc giữa hai giai đoạn.
- Một phiên ghi run cuối cùng mà biên tập viên đã xem. Feedback cho run trước đó trong cùng phiên không được tính.
- Việc đối chiếu được ghi tay bên ngoài hệ thống.
- Phiên do client của biên tập viên báo lên. Một người dùng đã đăng nhập có thể gửi thẳng qua API, và phiên không được gộp theo biên tập viên hay item, nên một biên tập viên mở lại cùng một item nhiều lần vẫn cộng thêm phiên. Hãy xem số biên tập viên và item khác nhau. Bước đối chiếu thủ công vẫn bắt buộc trước khi `go`.
- `time_reduction` là một giá trị điểm, không có khoảng tin cậy (xem Sai số chấp nhận).
