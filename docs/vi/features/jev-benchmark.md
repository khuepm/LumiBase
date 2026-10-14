---
version: 1
lastUpdated: 2026-10-14T10:41:48.377Z
sourceLang: en
translatedFrom: en
sourceHash: a31316298504e134
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-14T10:41:48.377Z
codeVerifiedHash: a31316298504e134
codeVerifiedClaims: 8
---

# Benchmark Jev (dữ liệu biên tập tiếng Việt và tiếng Anh)

Benchmark Jev đo cách một decision provider trả lời các câu hỏi kiểm tra bản nháp của LumiBase trên các mẫu biên tập tiếng Việt và tiếng Anh đã gán nhãn. Đây là công cụ đánh giá, không phải tính năng sản phẩm: không phần nào chạy trong CMS và không phần nào nằm trong bundle Cloudflare Worker.

**Trạng thái: chưa có kết quả đo.** Harness, dataset và protocol đã có, nhưng chưa ghi nhận lần chạy nào với provider thật (Jev qua TypeSafe hoặc OpenRouter, hoặc LLM đã cấu hình). Vì vậy chưa có quyết định target precision/coverage và chưa có go/no-go cho automation. Không trích số liệu mock như kết quả của model.

Code: `apps/cms/eval/jev-benchmark/` (dataset, metric, threshold, report) và `apps/cms/scripts/jev-benchmark.ts` (CLI).

## Dataset

`apps/cms/eval/jev-benchmark/datasets/v1/` chứa `manifest.json` và bốn split JSONL:

| File | Locale | Split | Số mẫu |
|---|---|---|---|
| `tune.vi.jsonl` | vi | tune | 40 |
| `heldout.vi.jsonl` | vi | heldout | 60 |
| `tune.en.jsonl` | en | tune | 40 |
| `heldout.en.jsonl` | en | heldout | 60 |

- **Chỉ dữ liệu synthetic.** Mọi mẫu được viết tay cho benchmark này. Không có dữ liệu khách hàng, người dùng hay production, và harness không bao giờ đọc nội dung từ database.
- **Cấu trúc mẫu:** `id`, `locale`, `split`, `fields` (`title`, `body`), `labels` (mỗi câu hỏi một nhãn) và `tags`.
- **Nhãn:** `category` là lựa chọn giữa `news`, `tutorial`, `product`, `opinion`, `event`, cộng `other` (nội dung thật nằm ngoài taxonomy) và `unknown` (quá ít nội dung để quyết định). `needs_review` là boolean. Hướng dẫn gán nhãn nằm trong manifest.
- **Tag:** `in-taxonomy`, `ambiguous`, `out-of-taxonomy`, `thin-content`, `prompt-injection`, `needs-review`. Mọi tag đều có mặt ở mọi locale và split. Mẫu prompt-injection giấu chỉ dẫn nhắm vào model bên trong nội dung và luôn được gán `needs_review: true`.
- **Đóng băng.** Manifest ghi sha256 và số dòng của từng split. Loader (`loadDataset`) từ chối split đã bị sửa. Muốn đổi dữ liệu thì phát hành dataset version mới; không sửa `v1`.

## Rubric

Câu hỏi lấy từ các review preset của J05 (`apps/cms/src/services/review-presets.ts`): `category` từ `taxonomy` và `needs_review` từ `brand-voice`. Benchmark đo đúng rubric mà sản phẩm đang dùng. Nội dung chỉ đi trong `state`; câu hỏi không bao giờ đến từ nội dung.

Manifest ghim `profile.rubricVersion`, cùng fingerprint với `decisionRubricVersion` trong decision audit. Nếu preset thay đổi, CLI dừng với "Rubric drift": kết quả của hai rubric không so sánh được với nhau.

## Protocol

1. **Tune.** Chạy split `tune`. Với mỗi action, locale và provider, harness chọn threshold thấp nhất trên lưới mà selective precision đạt target với ít nhất `minCoveredSamples` mẫu đã quyết định. Nó ghi `thresholds.json`.
   - `tag` (câu hỏi `category`): cắt theo confidence của choice.
   - `route` (câu hỏi `needs_review`): cắt đối xứng trên P(true), `true` khi `p >= t`, `false` khi `p <= 1 - t`, abstain ở giữa.
   - Target là selective precision 0.9 cho cả hai action trong protocol version 1. Khi lưới không đạt được, threshold là `null` với status `target-not-reached`.
2. **Held-out.** Chạy split `heldout`. Nó nạp `thresholds.json` đã đóng băng và kiểm tra file được tạo cho đúng mode, provider, model, dataset, rubric và protocol. Nó không bao giờ ghi threshold (`writeThresholds` ném `LeakageError`).
3. **So sánh.** Gộp các report held-out của từng provider thành một bảng so sánh.

Threshold là ngưỡng cắt trên điểm mà provider báo, được chọn theo tỷ lệ sai chấp nhận được. Nó không biến điểm đó thành xác suất trả lời đúng.

## Metric

Mọi hàm metric đều thuần (`apps/cms/eval/jev-benchmark/metrics.ts`). VI và EN luôn được báo cáo riêng.

- **Coverage / abstention:** một mẫu được *quyết định* khi lời gọi thành công, câu trả lời vượt threshold và không phải `unknown`. Lỗi được tính là abstention.
- **Selective precision:** số mẫu đã quyết định đúng / số mẫu đã quyết định.
- **Precision và recall theo nhãn.** Mẫu abstain hoặc lỗi bị tính là bỏ sót khi tính recall.
- **Brier và ECE** (10 bin bằng nhau) trên các mẫu có câu trả lời. Chúng mô tả xác suất được báo khớp với các nhãn này đến đâu. Chúng không phải xác suất trả lời đúng.
- **Lời gọi:** lỗi và timeout theo mã lỗi, độ trễ p50/p95 (nearest rank), token usage khi provider báo, và chi phí chỉ khi bạn truyền giá và mọi lời gọi thành công đều báo usage.
- **Khoảng tin cậy:** mỗi tỷ lệ đi kèm khoảng Wilson 95%. Với 40–60 mẫu mỗi locale và split, khoảng rất rộng; hãy đọc mọi con số cùng khoảng của nó.
- **Lát cắt:** kết quả thô theo từng tag (ví dụ `prompt-injection`, `out-of-taxonomy`).

## Lệnh

```bash
# Harness check without keys (seeded oracle, mode: "mock")
pnpm -F @lumibase/cms bench:jev -- --provider mock --split tune
pnpm -F @lumibase/cms bench:jev -- --provider mock --split heldout

# Live runs; each sends the synthetic dataset to the provider and is billed
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split tune
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split heldout
OPENROUTER_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider openrouter --split heldout

# Provider comparison (same mode, split, dataset, rubric and protocol only)
pnpm -F @lumibase/cms bench:jev -- --merge a/report.heldout.json --merge b/report.heldout.json --out comparison.json
```

Tuỳ chọn: `--dataset v1`, `--out <dir>` (mặc định `apps/cms/eval/jev-benchmark/reports/<dataset>/<provider>/`, đã git-ignore), `--thresholds <file>`, `--concurrency <n>` (mặc định 1; rate limit bị tính là lỗi), `--price-input-per-mtok` và `--price-output-per-mtok` (USD).

`--provider llm` dùng `LLM_PROVIDER` đã cấu hình. Xác suất của nó do model tự báo và `calibrated: false`, nên threshold của nó không bao giờ áp dụng cho Jev.

Mỗi lần chạy ghi `report.<split>.json` và `results.<split>.jsonl` (câu trả lời từng mẫu, không kèm nội dung). Report ghi dataset version và hash của manifest, rubric version, protocol version, seed, split, mode và số mẫu.

## Chế độ mock

`--provider mock` trả lời từ nhãn chuẩn kèm nhiễu có seed và lỗi giả lập. Số liệu của nó chỉ cho thấy harness hoạt động. Report của nó mang `mode: "mock"` cùng ghi chú nói rõ điều đó, và harness từ chối gộp report khác mode, nên kết quả mock không thể lọt vào bảng so sánh live.

## Smoke test live

`apps/cms/src/services/__tests__/decision-live.smoke.test.ts` gửi một request synthetic (noul, choice và score) tới mỗi endpoint Jev. Test bị bỏ qua trừ khi có `TYPESAFE_API_KEY` hoặc `OPENROUTER_API_KEY`, nên CI thông thường không bao giờ gọi provider. Nó chỉ kiểm tra hợp đồng của câu trả lời, không kiểm tra chất lượng.

```bash
TYPESAFE_API_KEY=... OPENROUTER_API_KEY=... pnpm -F @lumibase/cms exec vitest --run src/services/__tests__/decision-live.smoke.test.ts
```

## Giới hạn

- Chưa có kết quả live, nên chưa có target, số đo held-out hay go/no-go cho automation. Automation vẫn tắt cho tới khi có những thứ đó.
- Các mẫu là synthetic và ngắn. Chúng không phải mẫu đại diện cho nội dung của site thật nào, và kết quả có thể không áp dụng cho bài dài hoặc nội dung chuyên ngành.
- `v1` do một người gán nhãn; chưa đo độ đồng thuận giữa người gán nhãn. Mẫu có tag `ambiguous` có nhiều hơn một nhãn hợp lý.
- Câu hỏi `score` chưa được gán nhãn trong `v1`. Chỉ `category` và `needs_review` được đo.
- Benchmark gọi provider trực tiếp, không qua đường governance của CMS (quota, audit). Nó đo câu trả lời, không đo độ trễ end-to-end của sản phẩm.
- Độ trễ phụ thuộc vào mạng và vùng của máy chạy benchmark.
