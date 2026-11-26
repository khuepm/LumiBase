---
version: 3
sourceLang: en
lastUpdated: 2026-11-26T05:28:45.634Z
translatedFrom: en
sourceHash: 83bf2e22af4d7419
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-26T05:28:45.634Z
codeVerifiedHash: 83bf2e22af4d7419
codeVerifiedClaims: 6
---

# ADR-016: Retrieval có quản trị — chọn engine dựa trên bằng chứng

**Date:** 2026-11-26  
**Status:** Proposed (B180 chỉ đóng tại R06)

## Context

AI skill cần nội dung liên quan tới chỉ dẫn mà nó nhận được. Hiện nay nó
không nhận được. Audit #581
(`docs/review-agent/2026-11-01-ai-audit-581-embedding-retrieval-baseline.md`)
đo được Recall@3 0.5 và MRR@3 0.4583 trên `apps/cms/eval/retrieval/dataset.v1.json`,
và nêu rõ lý do: retriever bỏ qua query và trả về ba item được sửa gần nhất,
nên các con số đo `updated_at` chứ không đo độ liên quan. Audit để việc chọn
một retriever thật cho owner quyết định (**B180**), khuyến nghị pgvector trước
khi corpus đạt 10⁴–10⁵ vector, và để ngỏ hai quyết định liên quan: có được gửi
PII/PHI đã giải mã sang model provider bên ngoài hay không (**B179**), và việc
search index áp row rule lên một snapshot cũ và bỏ qua job index lỗi (**B181**).

Những gì đang có trong code:

- `apps/cms/src/services/embedding-service.ts` có provider OpenAI, Workers AI
  và Echo. `createEmbeddingProvider` chọn provider theo `LLM_PROVIDER` và âm
  thầm trả về `EchoEmbeddingProvider` khi thiếu key hoặc provider không xác định.
- `lumibase_ai_embeddings` (`packages/database/src/schema/ai.ts`) lưu vector
  dạng JSONB kèm `site_id`; độ tương đồng tính bằng `cosineSimilarity` brute-force
  trong JS. Chưa có pipeline nào ghi vào bảng này.
- `SearchProvider` (`packages/runtime/src/interfaces/search.ts`) đã có đủ
  `index`, `search`, `delete`, `getIndex` và `configureIndex`, với adapter
  MeiliSearch cho cả hai runtime. Ranh giới tenant nằm trong tên index
  (`searchIndexName(siteId, collection)`). Code hỗ trợ Meili trên Workers; việc
  production đã provision một instance Meili hay chưa thì chưa được xác minh.
- Content environments (Epic #853) đang ở Phase A: một bộ đếm optimistic
  concurrency. Chưa có cột `environment_id` nào.

Một đề xuất dùng MongoDB Atlas và Voyage AI, xuất phát từ startup credits, đã
được phản biện dựa trên các điểm trên. Đề xuất đó trộn ba quyết định độc lập —
embedding model, vector store, chiến lược retrieval — và đọc baseline #581 như
một khoảng trống về vector store, trong khi thực tế không phải vậy. ADR này
tách chúng ra.

## Options

| Phương án | Tận dụng hạ tầng hiện có | Ngữ nghĩa | Cùng transaction / RLS với dữ liệu gốc | Vận hành thêm | Đường chạy trên Workers |
| --- | --- | --- | --- | --- | --- |
| A. Meili lexical (`SearchProvider`) | có | không | không | không (nếu đã provision) | adapter sẵn có |
| B. Meili hybrid, vector `userProvided` | có | có | không | không (nếu đã provision) | adapter sẵn có |
| C. pgvector trong database của CMS | có | có | có thể | extension + tinh chỉnh HNSW | kết nối PG sẵn có |
| D. MongoDB (Atlas hoặc Community + `mongot`) | không | có | không | một datastore thứ ba | cần spike driver |

Các thông tin từ nhà cung cấp được nêu trong quá trình phản biện, tác giả ADR
này chưa tự kiểm tra lại: MongoDB Community Search / Vector Search GA từ bản 8.2
và cần process `mongot`, vốn dùng giấy phép SSPL; các model embedding `voyage-4*`
và rerank `rerank-3*` của Voyage đang active, `rerank-2.5-lite` là legacy. R01
kiểm tra lại các thông tin này với tài liệu nhà cung cấp, kèm ngày truy cập,
trước khi bất kỳ thông tin nào được dùng để ra quyết định.

## Decision

1. **PostgreSQL vẫn là source of truth** cho item, quyền, approval, audit và
   provenance. Mọi retrieval index đều là dữ liệu dẫn xuất.
2. **Một `RetrievalService` duy nhất trong `apps/cms/src/services/`** điều phối
   retrieval. Service áp tenant scope, kiểm tra quyền trực tiếp và kiểm tra revision. Nó dùng lại `ItemService` và các
   policy service hiện có để kiểm tra quyền, không tự viết RBAC riêng. Không có
   hệ thống `RetrievalProvider` mới và không có package mới. Candidate lexical
   lấy từ `SearchProvider` sẵn có; interface vector ở tầng thấp hơn chỉ được
   thêm khi thực sự xây một vector store (R05).
3. **Embedding provider độc lập với datastore.** Embedding, reranking và
   generation được cấu hình riêng. Voyage được thêm dưới dạng một
   `EmbeddingProvider`, với `inputType` là `query` hoặc `document`. Tên model là
   cấu hình; mỗi lần chạy benchmark phải pin model, số chiều, cấu hình và phiên
   bản index.
4. **Meili hybrid với vector `userProvided` (phương án B) là thí nghiệm được ưu
   tiên**, không phải bước đệm: nếu đạt Gate A thì nó có thể là lời giải cho
   production. LumiBase tự gọi Voyage rồi đưa vector cho Meili, để nội dung không
   bao giờ đi ra ngoài qua một REST embedder phía Meili vốn bỏ qua chính sách
   egress, việc đo usage và audit.
5. **pgvector (phương án C) là ứng viên có điều kiện**, chỉ xây nếu Gate A
   không đạt. **MongoDB (phương án D) được hoãn**: chỉ thử nếu R06 chỉ ra một
   vấn đề cụ thể mà C không giải quyết được. ADR này không thêm datastore nào
   vào production. Startup credits được tính vào ngân sách R&D, không bao giờ
   tính vào TCO ở trạng thái ổn định.
6. **Data egress mặc định là từ chối (B179 — Proposed, chờ owner duyệt).**
   Quyền đọc không đồng nghĩa với quyền index hay gửi nội dung cho bên thứ ba.
   PII/PHI, credential và field mã hoá bị loại khỏi indexing, embedding query và
   reranking trừ khi có policy cho phép. Chính sách áp dụng cho mọi provider
   (OpenAI, Voyage, Workers AI, …). Các capability cần cho việc này ("được phép
   index", "được phép gửi sang provider bên ngoài") là mới và được thiết kế
   trong R01; hiện chưa tồn tại.
7. **Các bất biến của retrieval**, bất kể engine nào được chọn:
   - mỗi chunk chỉ chứa văn bản của đúng một field, và query lọc theo các field
     mà principal được đọc — một vector tạo từ field bị ẩn vẫn rò rỉ qua thứ
     hạng ngay cả khi field đó đã bị che trong kết quả;
   - tenant, status và phạm vi field là pre-filter; row rule nào không biểu diễn
     được thành filter của index thì được kiểm tra ở bước hydration với
     PostgreSQL, có over-fetch, và tỉ lệ thiếu kết quả được đo;
   - kiểm tra quyền trực tiếp và kiểm tra revision chạy trước reranking, trước
     khi bất cứ thứ gì vào prompt, và áp cho cả kết quả, snippet, score lẫn
     metadata;
   - xoá, thu hồi quyền và đổi phân loại phải chặn chunk bị trả về ngay cả khi
     indexer chưa bắt kịp (B181);
   - telemetry mặc định không lưu nội dung hay query thô;
   - khi Epic #853 thêm environment, khoá index và mọi filter retrieval đều chứa
     environment, và được ghi vào Setup Impact Registry.
8. **Benchmark dùng để quyết định, không để nghiệm thu.** Bắt đầu với một bộ
   tối thiểu: 80 query có người duyệt (15 keyword/entity, 15 diễn đạt lại,
   10 EN↔VI, 5 nhiều tài liệu, 10 không có đáp án, 5 cũ/mâu thuẫn, 20 bẫy
   tenant/quyền). LLM có thể soạn nháp query và nhãn; nó không bao giờ là bên
   phán định duy nhất. Các bẫy bổ sung chứ không thay thế integration test cho
   isolation, thu hồi quyền và xoá. Không đặt mục tiêu Recall cố định khi E1
   chưa có.

   | ID | Thí nghiệm | Chạy |
   | --- | --- | --- |
   | E0 | 3 item mới nhất (baseline #581) | luôn |
   | E1 | Meili lexical | luôn |
   | E2 | E1 + Voyage rerank | luôn |
   | E2.5 | Meili hybrid + Voyage embedding (`userProvided`) | luôn |
   | E3–E6 | pgvector exact / HNSW / hybrid / + rerank | nếu Gate A không đạt |
   | E7 | MongoDB, cùng embedding | nếu R06 cần |

   Ma trận có thể dừng ở E2 hoặc E2.5. Phương án nào được chọn cũng phải chạy
   scale test ở workload dự kiến, kể cả khi có tải CRUD đồng thời của CMS.

### Plan and gates

| ID | Công việc | Phụ thuộc |
| --- | --- | --- |
| R01 | Policy B179, mô hình đe dọa qua xếp hạng, contract phân giải S5, audit Meili production và xác minh thông tin nhà cung cấp | — |
| R02 | Gán nhãn và chia bộ đánh giá, chốt tiêu chí quyết định | R01 |
| R03 | Retrieval lexical có quản trị, kiểm tra quyền và vòng đời chunk theo field (B181) | R01 |
| R04 | Voyage E2/E2.5 với vector có phiên bản, phân giải qua S5 và usage emitter hiện có | R01 (B179 đã duyệt), R02, R03, contract S5 |
| Gate A | Dừng thử engine nếu ứng viên Meili đạt các tiêu chí đã chốt | R03, R04 |
| R05 | Lưu trữ pgvector có điều kiện, đánh giá exact search và HNSW | Gate A không đạt |
| R06 | chọn engine cuối cùng và TCO; đóng B180 | Gate A hoặc R05 |

Agent memory, phát hiện mâu thuẫn, tìm kiếm đa phương thức, quan hệ nội dung
và adapter MongoDB nằm trong backlog, không thuộc phạm vi này. Nền tảng
retrieval thuộc Community (`khuepm/LumiBase`); nếu sau này có adapter MongoDB
thì nó cũng thuộc Community.

### Tiêu chí triển khai và nghiệm thu

- **Gọi provider.** R01 định nghĩa contract S5 trong Community. Từ tenant và tác vụ (generation, embedding tài liệu, embedding truy vấn hoặc reranking), phân giải provider, model và tham chiếu credential. Kiểm tra B179 theo đích nhận và dữ liệu thực gửi trước khi gọi. Quyền index độc lập với quyền gửi ra ngoài. Copilot, Jev, agent, flow decision, worker lập chỉ mục và index bên ngoài đều dùng chung bước kiểm tra. Adapter chỉ nhận tác vụ đã được phép. R04 tích hợp resolver trước lần gọi provider đầu tiên. Community cung cấp cấu hình cục bộ, Enterprise có thể cung cấp chế độ managed.
- **Thông tin lộ qua tìm kiếm.** R01 mô hình hóa thứ hạng, số lượng, điểm, kết quả thiếu và thời gian phản hồi. R03 thử cùng principal và truy vấn trên hai tập dữ liệu chỉ khác nhau ở row hoặc field bị ẩn, kể cả khi row ẩn chiếm hết top-k. So sánh thứ tự công khai, số lượng, điểm, độ dài kết quả và phân phối độ trễ. Khoanh vùng candidate trước khi xếp hạng hoặc dùng phương án truy vấn theo quyền. Ghi nhận tín hiệu còn lộ và lấy quyết định chấp nhận của owner trước khi triển khai.
- **Vòng đời index.** R03 định danh chunk theo site, collection, item, field và vị trí. Gắn revision nguồn với mỗi lần ghi, retry idempotent, xóa chunk thừa khi sửa hoặc xóa item và dựng lại index từ PostgreSQL. Kiểm thử job đến sai thứ tự và thu hồi quyền. R04 quản lý phiên bản vector theo model và số chiều, reindex trước khi chuyển phiên bản.
- **Tiêu chí quyết định.** R02 tách riêng tập tuning và held-out. Dùng E1 trên tập tuning để chốt mức cải thiện relevance tối thiểu, bất biến bảo mật bắt buộc, workload, trần độ trễ và chi phí vận hành. Chốt ngưỡng và điều kiện dừng hoặc chuyển bước trước khi đánh giá ứng viên. Báo cáo kết quả held-out tại Gate A và chỉ đóng B180 tại R06.
- **Usage và hạch toán.** Ghi nhận usage cho indexing, reindexing, query embedding và reranking qua emitter hiện có. Enterprise #25/#26/#27 phụ trách phân giải managed, phân bổ usage và sổ cái credit. Billing managed giữ trước ngân sách, quyết toán usage thực tế theo cách idempotent và đối soát kết quả còn thiếu. Telemetry best-effort có thể mất sự kiện nên không đủ căn cứ để trừ credit.

## Consequences

- Không thêm datastore, package hay dependency runtime nào cho tới khi bằng
  chứng đòi hỏi. `apps/cms/wrangler.toml` giữ `compatibility_date = "2024-10-01"`;
  ADR này không nâng phiên bản mà driver MongoDB trên Workers sẽ cần.
- Lỗi âm thầm fallback sang Echo là bug trên `main` và được sửa riêng, trong
  khuôn khổ release freeze, dưới dạng `fix(ai)`: provider đã cấu hình mà thiếu
  credential hoặc provider không xác định thì báo lỗi rõ ràng; Echo chỉ chạy khi
  được chọn tường minh trong dev/test; CMS vẫn khởi động khi tắt embedding, kể cả khi chỉ cấu hình Anthropic; thông báo lỗi không
  chứa credential. Việc thêm `EMBEDDING_PROVIDER`, Voyage và reranking là công
  việc tính năng cho nhánh epic.
- Công việc tính năng vào nhánh `epic/<issue>-governed-retrieval` trong khi
  freeze v2.2.0 còn hiệu lực.
- Phương án B giữ retrieval nằm ngoài transaction của dữ liệu gốc, nên B181 và
  kiểm tra quyền trực tiếp vẫn bắt buộc; chọn B không bỏ được phần việc của R03.
- B180 còn mở cho tới R06. B179 do owner quyết định; cho tới lúc đó R04 không
  gửi nội dung sang provider bên ngoài, ngoài dữ liệu test fixture.
