---
version: 6
sourceLang: en
lastUpdated: 2026-11-26T06:00:33.803Z
translatedFrom: en
sourceHash: cf16e470486c2591
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-26T06:00:33.803Z
codeVerifiedHash: cf16e470486c2591
codeVerifiedClaims: 16
---

# ADR-016: Retrieval có quản trị — chọn engine dựa trên bằng chứng

**Date:** 2026-11-26  
**Status:** Proposed (Decision Gate A quyết định có thử thêm engine hay không; chỉ R06 đóng B180)

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
  Với `LLM_PROVIDER=anthropic`, nó dùng OpenAI khi có `OPENAI_API_KEY` và dùng
  Echo trong trường hợp còn lại.
- `lumibase_ai_embeddings` (`packages/database/src/schema/ai.ts`) lưu vector
  dạng JSONB kèm `site_id`; độ tương đồng tính bằng `cosineSimilarity` brute-force
  trong JS. Chưa có pipeline nào ghi vào bảng này.
- `SearchProvider` (`packages/runtime/src/interfaces/search.ts`) đã có đủ
  `index`, `search`, `delete`, `getIndex` và `configureIndex`, với adapter
  MeiliSearch cho cả hai runtime. Ranh giới tenant nằm trong tên index
  (`searchIndexName(siteId, collection)`). Code hỗ trợ Meili trên Workers; owner
  xác nhận ngày 26-11-2026 production chưa có Meili. Dùng instance thử nghiệm
  riêng và tính chi phí cấp phát vào TCO.
- `buildSearchDocument` (`apps/cms/src/services/search-document.ts`) index mọi
  field của một item thành một document. `apps/cms/src/routes/search.ts` áp row
  rule và che field sau khi Meili trả hit về, và đã báo `totalHits` là số hit
  nhìn thấy được cho caller bị giới hạn quyền (#738).
- `PlatformSeams` (`apps/cms/src/platform/types.ts`) có `entitlements`, `usage`
  và `externalActions`. Chưa có seam nào phân giải AI provider cho một lời gọi:
  lời gọi model được cấu hình từ biến môi trường của instance, còn đường
  embedding và decision tự gọi thẳng tới nhà cung cấp.
- `recordUsage` (`apps/cms/src/platform/usage.ts`) là best-effort: không có
  emitter đăng ký thì không ghi gì, event nằm ngoài usage scope bị bỏ, và event
  được flush sau response, flush lỗi thì được log và không ảnh hưởng request.
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
2. **Bốn trách nhiệm, bốn nơi.** Không có hệ thống `RetrievalProvider` mới và
   không có package mới.

   | Tầng | Chịu trách nhiệm | Không chịu trách nhiệm |
   | --- | --- | --- |
   | `RetrievalService` (`apps/cms/src/services/`) | điều phối retrieval: tenant scope, kiểm tra quyền trực tiếp, kiểm tra revision, gộp candidate và thứ tự rerank | chọn provider, credential, quy tắc egress |
   | Chính sách data egress (dùng chung) | quyết định một nội dung có được index hay không, và tách riêng, có được rời ra provider hoặc index bên ngoài hay không | dùng provider hay credential nào |
   | Seam phân giải AI provider | provider, model và credential nào phục vụ một lời gọi | nội dung có được gửi đi hay không |
   | Provider adapter | lời gọi kỹ thuật, sau hai quyết định ở trên | bất kỳ chính sách nào |

   `RetrievalService` dùng lại `ItemService` và các policy service hiện có để
   kiểm tra quyền, không tự viết RBAC riêng. Candidate lexical lấy từ
   `SearchProvider` sẵn có; interface vector ở tầng thấp hơn chỉ được thêm khi
   thực sự xây một vector store (R05).
3. **Retrieval cũng dùng một đường phân giải AI provider duy nhất.** Embedding
   document, embedding query và reranking phân giải provider qua cùng seam với
   generation; retrieval không thêm gateway, client hay cách tra credential
   riêng. Seam đó chưa tồn tại: nó là một issue core riêng (single AI provider
   resolution path) mà R04 phụ thuộc vào. Contract của nó trung lập và nằm ở
   `@lumibase/contracts`; mặc định của nó phân giải từ cấu hình instance đúng
   như hiện nay, nên Community không cần gì thêm để dùng. Với retrieval,
   contract phải bao gồm:
   - một `EmbeddingProvider` với `inputType` là `query` hoặc `document`, và một
     lời gọi reranking, được phân giải theo từng lời gọi kèm mục đích
     (`embedding.document`, `embedding.query`, `rerank`) và tenant;
   - job indexing chạy nền, phân giải qua cùng đường đó bên trong một usage
     scope (`runWithUsageScope`), không chỉ query lúc request;
   - resolver lỗi thì báo lỗi, không bao giờ âm thầm chuyển sang provider hay
     credential khác.

   Embedding, reranking và generation được cấu hình riêng. Tên model là cấu
   hình; mỗi lần chạy benchmark phải pin model, số chiều, cấu hình và phiên bản
   index. Usage (token, số lời gọi, đơn vị đã index) được báo bằng `recordUsage`
   sẵn có; không xây một hệ thống metering riêng cho retrieval. Các event đó là
   báo cáo best-effort. Chúng không phải sổ cái kế toán, và không gì trong core
   coi chúng là sổ cái: deployment nào cần hạch toán chính xác hoặc hard budget
   thì tự xây cơ chế đặt trước, quyết toán, idempotency và đối soát bên ngoài
   đường này.
4. **Meili hybrid với vector `userProvided` (phương án B) là thí nghiệm được ưu
   tiên**, không phải bước đệm: nếu đạt Gate A thì nó có thể là lời giải cho
   production. LumiBase tự tính vector qua seam phân giải rồi đưa cho Meili, để
   nội dung không bao giờ đi ra ngoài qua một REST embedder phía Meili vốn bỏ
   qua chính sách egress, báo cáo usage và audit.
5. **pgvector (phương án C) là ứng viên có điều kiện**, chỉ xây nếu Gate A
   không đạt. **MongoDB (phương án D) được hoãn**: chỉ thử nếu R06 chỉ ra một
   vấn đề cụ thể mà C không giải quyết được. ADR này không thêm datastore nào
   vào production. Startup credits được tính vào ngân sách R&D, không bao giờ
   tính vào TCO ở trạng thái ổn định.
6. **Data egress mặc định là từ chối (B179 — owner duyệt ngày 26-11-2026).**
   - Quyền gửi khớp theo site, loại dữ liệu và đích nhận cho mọi tác vụ.
   - Quyền đọc không đồng nghĩa với quyền index hay gửi nội dung cho bên thứ
     ba, và hai quyền này là hai capability riêng: "được phép index" (vào một
     index dẫn xuất do deployment tự vận hành) và "được phép rời ra provider
     hoặc index bên ngoài" (nhà cung cấp model, dịch vụ search được host). Một
     field có thể được index mà vẫn không được rời ra ngoài.
   - PII/PHI, credential và field mã hoá bị loại khỏi indexing, embedding
     document và query, và reranking trừ khi có policy cho phép.
   - Chính sách dùng chung, không thuộc `RetrievalService`. Nó được kiểm tra ở
     mọi điểm nội dung rời ra một AI provider hoặc một index bên ngoài: query
     retrieval, indexing và reindexing chạy nền, Copilot, review run, agent run
     và flow AI decision. Nó áp dụng cho mọi provider (OpenAI, Voyage, Workers
     AI, Anthropic, …).
   - Các capability này là mới và được thiết kế trong R01; hiện chưa tồn tại.
     R01 cũng liệt kê các đường gửi ra ngoài đang có, để mỗi đường hoặc được nối
     vào chính sách, hoặc được ghi tên thành việc tiếp theo.
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
8. **Kiểm tra quyền trực tiếp tự nó không bảo đảm không rò rỉ.** Các row mà
   principal không được đọc vẫn có thể ảnh hưởng tới những gì nó quan sát được:
   chúng có thể chiếm hết top-k khiến hydration trả về ít hoặc không có kết
   quả, thay đổi thứ tự và score của các row còn lại, thay đổi số lượng, và thay
   đổi độ trễ. Một principal dò một từ khoá bí mật có thể đọc ra những khác biệt
   đó. Vì vậy:
   - R01 viết threat model cho các kênh rank, count, score, thiếu kết quả và
     timing, và nêu rõ phần rủi ro còn lại mà owner chấp nhận (ví dụ: một row
     rule không thể là pre-filter của index thì để lại tín hiệu thiếu kết quả);
   - R03 chứng minh bằng test rằng các row không được đọc không làm thay đổi tín
     hiệu công khai vượt quá phần rủi ro đã chấp nhận đó: số lượng theo #738 (số
     nhìn thấy được cho caller bị giới hạn quyền), score không lộ ra cho caller
     bị giới hạn quyền, và hành vi thiếu kết quả cùng timing được đo khi có và
     khi không có match không được đọc;
   - cái gì làm được pre-filter thì là pre-filter; post-filter là phương án dự
     phòng, không phải thiết kế.
9. **Benchmark dùng để quyết định, không để nghiệm thu.** Bắt đầu với một bộ
   tối thiểu: 80 query có người duyệt (15 keyword/entity, 15 diễn đạt lại,
   10 EN↔VI, 5 nhiều tài liệu, 10 không có đáp án, 5 cũ/mâu thuẫn, 20 bẫy
   tenant/quyền). LLM có thể soạn nháp query và nhãn; nó không bao giờ là bên
   phán định duy nhất. Các bẫy bổ sung chứ không thay thế integration test cho
   isolation, thu hồi quyền và xoá.

   Không đặt mục tiêu Recall tuyệt đối khi E1 chưa có, nhưng điều kiện thắng
   được chốt trước khi bất kỳ ứng viên nào được so với E1. R02 chia query thành
   tập tuning và tập held-out, và ghi vào repo, trước khi E2 chạy:
   - mức cải thiện độ liên quan tối thiểu so với E1 trên tập held-out mà một
     ứng viên phải đạt;
   - các bất biến bảo mật (quyết định 7 và 8), vi phạm bất kỳ bất biến nào là
     loại ứng viên bất kể độ liên quan;
   - ngân sách độ trễ và workload dự kiến dùng để đo;
   - chi phí vận hành chấp nhận được;
   - quy tắc dừng: khi nào ma trận dừng, và khi nào chuyển sang ứng viên tiếp
     theo.

   Tinh chỉnh chỉ dùng tập tuning; tập held-out được chấm một lần cho mỗi cấu
   hình ứng viên. Đổi một tiêu chí sau khi đã có kết quả thì phải ghi lý do
   trong ADR này.

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
| R01 | các mục còn mở của ADR này: policy B179 (cả hai capability, mọi đường gửi ra ngoài), threat model rò rỉ, audit việc provision Meili trên production, kiểm tra thông tin nhà cung cấp | — |
| R02 | bộ đánh giá tối thiểu (độ liên quan + bảo mật), chia tập tuning/held-out, điều kiện thắng chốt trước | R01 |
| R03 | retrieval lexical có quản trị: `RetrievalService`, kiểm tra quyền trực tiếp, test side channel; vòng đời index tối thiểu dùng chung cho mọi engine — chunk một field, index có phiên bản, upsert, xoá, reindex, retry job lỗi (B181) | R01 |
| AI seam | đường phân giải AI provider duy nhất (issue core riêng), bao gồm embedding và reranking | — |
| R04 | adapter Voyage sau seam, E2 và E2.5, usage qua `recordUsage` | R01 (B179 đã duyệt), R02, R03, AI seam |
| Gate A | Meili hybrid có đạt các điều kiện của R02 không? Quyết định có thử thêm engine hay không | R03, R04 |
| R05 | chỉ phần đặc thù của pgvector: schema, extension, HNSW, interface vector (chỉ khi Gate A không đạt) | Gate A |
| R06 | chọn engine cuối cùng và TCO; đóng B180 | Gate A, và R05 khi R05 được chạy |

Vòng đời index không phải việc của pgvector: E2.5 đã cần embedding theo chunk,
phiên bản, upsert, xoá và reindex, và một lời giải Meili hybrid cho production
cũng cần như vậy nếu R05 không bao giờ chạy. R04 chỉ chạy E2 và E2.5 trên dữ
liệu tích hợp khi đã có contract kiểm tra quyền và indexing của R03.

### Acceptance criteria

- **Lời gọi provider (R01, R04).** R01 định nghĩa contract phân giải: đầu vào
  là tenant và thao tác (generation, embedding document, embedding query,
  reranking); đầu ra là provider, model và tham chiếu credential. Kiểm tra B179
  chạy trên đích đến và payload thực tế trước khi gửi đi. R04 tích hợp resolver
  trước lời gọi provider đầu tiên.
- **Khả năng quan sát của search (R01, R03).** R03 chạy cùng principal và query
  trên các corpus chỉ khác nhau ở row hoặc field không được truy cập, kể cả các
  row đủ để chiếm hết top-k, và so sánh thứ tự nhìn thấy được, số lượng, score,
  độ dài kết quả và phân bố độ trễ. Tập candidate được giới hạn trước khi xếp
  hạng, hoặc dùng một phương án dự phòng có phạm vi theo quyền. Mọi tín hiệu
  còn sót lại được ghi lại và được owner chấp nhận trước khi rollout.
- **Vòng đời index (R03, R04).** Chunk được định khoá theo site, collection,
  item, field và vị trí chunk. Lần ghi được đánh phiên bản theo revision gốc và
  retry idempotent; chunk lỗi thời bị xoá khi cập nhật và khi xoá; index có thể
  dựng lại từ PostgreSQL. Test bao gồm job đến sai thứ tự và thu hồi quyền. R04
  đánh phiên bản vector theo model và số chiều, và reindex trước khi chuyển
  phiên bản.
- **Tiêu chí quyết định (R02, Gate A, R06).** E1 trên tập tuning đặt mức cải
  thiện độ liên quan tối thiểu; ngưỡng và quy tắc dừng/chuyển được chốt trước
  khi đánh giá ứng viên; kết quả held-out được báo cáo ở Gate A; B180 chỉ đóng
  ở R06.

Agent memory, phát hiện mâu thuẫn, tìm kiếm đa phương thức, quan hệ nội dung
và adapter MongoDB nằm trong backlog, không thuộc phạm vi này. Nền tảng
retrieval thuộc Community (`khuepm/LumiBase`); nếu sau này có adapter MongoDB
thì nó cũng thuộc Community. Seam phân giải và seam usage là những điểm mở rộng
duy nhất mà một deployment thương mại cần; core cung cấp mặc định cho chúng và
không phụ thuộc vào bất kỳ implementation nào khác.

## Consequences

- Không thêm datastore, package hay dependency runtime nào cho tới khi bằng
  chứng đòi hỏi. `apps/cms/wrangler.toml` giữ `compatibility_date = "2024-10-01"`;
  ADR này không nâng phiên bản mà driver MongoDB trên Workers sẽ cần.
- Lỗi âm thầm fallback sang Echo là bug trên `main` và được sửa riêng, trong
  khuôn khổ release freeze, dưới dạng `fix(ai)`. Bản sửa phân biệt ba trạng
  thái:

  | Trạng thái | Hành vi |
  | --- | --- |
  | Tắt embedding (không cấu hình embedding provider nào) | CMS khởi động và hoạt động bình thường; tính năng cần embedding báo là đang tắt |
  | Đã cấu hình provider nhưng thiếu credential, hoặc provider không xác định | báo lỗi rõ ràng, nêu tên setting, không chứa credential |
  | Echo | chỉ khi được chọn tường minh, và chỉ trong development hoặc test |

  Deployment dùng Anthropic cho generation và chưa cấu hình embedding provider
  nào thuộc dòng đầu tiên: nó vẫn hoạt động, chỉ không còn nhận vector Echo giả.
  Việc thêm `EMBEDDING_PROVIDER`, Voyage và reranking là công việc tính năng cho
  nhánh epic.
- Công việc tính năng vào nhánh `epic/<issue>-governed-retrieval` trong khi
  freeze v2.2.0 còn hiệu lực.
- Phương án B giữ retrieval nằm ngoài transaction của dữ liệu gốc, nên B181 và
  kiểm tra quyền trực tiếp vẫn bắt buộc; chọn B không bỏ được phần việc của R03.
- B180 còn mở cho tới R06; Gate A chỉ quyết định có thử thêm engine hay không.
  R04 phải thực thi B179 đã duyệt trước khi gửi dữ liệu thật.
