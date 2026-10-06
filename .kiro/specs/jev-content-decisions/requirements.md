# Jev — Trusted draft review and governed content automation

Ngày lập kế hoạch: 2026-10-06.
Epic chuẩn: [#507](https://github.com/khuepm/LumiBase/issues/507).
Baseline: PR #504 tại `73d3ca5e7c455f40a97aaf295fdd9acad094d3f2`.
Trạng thái: J01 implemented trên nhánh đang review; chưa merge hoặc nghiệm thu. Các phần còn lại planned.

## Mục tiêu sản phẩm

Biên tập viên kiểm tra bản nháp ngay trong Studio, nhận đề xuất chuyên mục và đánh giá theo tiêu chí của site, rồi chấp nhận/chỉnh sửa/từ chối. LumiBase đo được thời gian tiết kiệm và sai số trước khi cho phép tự động gắn nhãn, phân luồng hoặc phát hiện semantic drift.

Epic và child issues là nguồn scope, acceptance và trạng thái thực thi. Spec này giữ định hướng và các ràng buộc kiến trúc; không phải một board trạng thái thứ hai. Mỗi PR cập nhật spec khi thiết kế thay đổi. Không coi PR #504 đã merge hoặc các khả năng dự kiến đã có trên main.

## Yêu cầu

### R1 — Kết quả hợp lệ hoặc lỗi tường minh

- Thiếu/sai kiểu/out-of-range answer, thiếu option/level hoặc phân phối xác suất không hợp lệ phải thất bại rõ ràng.
- Không biến lỗi thành `noul=0`, `score=0`, Passed hoặc allow.
- Score là giá trị có trọng số trên các mức `0..N-1`; LLM provider dùng cùng semantic contract và luôn `calibrated=false`.
- Confidence không phải xác suất đúng. `calibrated=true` không chứng minh đã hiệu chỉnh trên dữ liệu LumiBase.

### R2 — Giới hạn tài nguyên và runtime

- Deadline tổng, timeout, cancellation, retry có giới hạn và tổng input budget áp dụng trước khi gọi upstream.
- Budget bao gồm state, instructions, criteria; character cap không được mô tả là token cap chính xác.
- Business logic dùng runtime abstraction, tương thích Workers/Docker; kiểm chứng async consumer thực tế trước khi tuyên bố parity.

### R3 — Quyền, dữ liệu và chi phí

- Xác thực, site membership, quyền dùng AI và row/field RBAC được kiểm tra tại mọi entry point.
- Tenant quota/cost reservation phải atomic và tính retry; usage không biết phải hiển thị unknown, không báo miễn phí.
- Site opt-in việc gửi dữ liệu tới provider; chỉ gửi field cho phép. Không tự dùng nội dung khách hàng cho benchmark.
- Audit không ghi mặc định raw content/secret/PII; có retention, kill switch và rollback.

### R4 — Review có phiên bản và nguồn gốc

- Review profile có taxonomy, các câu hỏi atomic, rubric và version theo site/collection.
- Review run gắn item/snapshot, revision/content hash, actual model/provider, profile version, outcome và feedback.
- Profile dùng nanoid; run/audit dùng uuidv7; queries luôn có site scope.
- Draft chưa lưu được review qua snapshot hợp lệ. Nội dung đổi thì kết quả cũ phải được đánh dấu stale.

### R5 — Studio hỗ trợ quyết định của biên tập viên

- Nút Kiểm tra bản nháp trong editor; hiển thị từng tiêu chí, đề xuất chuyên mục và uncertainty.
- Accept/edit/reject được ghi nhận. Apply chỉ cập nhật draft qua luồng có quyền, không tự publish hoặc ghi đè field pinned.
- Error/unconfigured/timeout/quota/cancel không hiển thị như review thành công.
- API client, token-store, base URL và shell contract hiện có phải được giữ; UI EN/VI, keyboard và mobile dùng được.
- Không bịa rationale hoặc trích dẫn khi model không trả reasoning/evidence.

### R6 — Chất lượng được đo trước rollout

- Dataset tối thiểu 200 mẫu có nhãn, ít nhất 100 VI và 100 EN, tách tuning/held-out và version hóa.
- Báo precision/recall theo nhãn, coverage/abstention, calibration cho probabilities, latency và usage/cost có thể đo.
- Live API smoke là opt-in, không có key ghi skipped/unverified; mock pass không thay thế live evidence.
- Pilot đề xuất tối thiểu 100 lượt review; chốt tiêu chí thành công trước thu mẫu, có baseline thời gian xử lý.
- Threshold riêng theo action/provider/locale; chưa đủ bằng chứng thì automation giữ shadow/deferred.

### R7 — Automation có quản trị

- Flows có decision operation và nhánh true/false/unknown/error được runner thực thi thật.
- Low-risk tagging/routing chỉ mở sau benchmark và pilot gate, có idempotency, human override và rollback.
- RBAC, autonomy level, HITL, pinned fields và kill switch hiện có quyết định quyền ghi; Jev chỉ cung cấp tín hiệu.
- Semantic drift mở rộng intent rules; provider lỗi không được clear drift hoặc báo clean. Tái dùng reconciler hiện có.

### R8 — Definition of Done

- Mỗi task có PR, head SHA, acceptance evidence và applicable repository DoD.
- Shared contract/OpenAPI/SDK cập nhật cùng hành vi API; docs EN/VI cùng PR và stamp theo hướng dẫn repo.
- Setup-impact, shell-impact, migrations và isolated DB tests khi áp dụng.
- Không đánh dấu Done khi chưa có runtime/key/pilot evidence cần thiết. Kế hoạch này không cấp quyền merge, deploy hoặc release.

## Ngoài phạm vi

- Tự động publish, delete hoặc đổi schema dựa vào Jev.
- Thay authorization bằng confidence score hoặc nâng autonomy tự động.
- Viết/dịch nội dung bằng Jev; fact-check toàn cục khi không có tài liệu nguồn.
- Automatic provider failover âm thầm hoặc dùng cùng threshold cho mọi provider.
- Xây lại approval/reconciler loop, dùng model cho rule xác định hoặc gộp dependency audit toàn repo vào backlog Jev.
