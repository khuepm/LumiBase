# DoD Review — High-Load & Cache Readiness

> Rà soát chương trình này theo từng mục của `.kiro/steering/definition-of-done.md`, thực hiện **tại thời điểm viết spec** (2026-07-04) và phải rà lại **tại mỗi lần đóng phase** (tasks 7.2, 15.2, 21.2). DoD áp cho từng PR/feature khi hoàn thành — bảng dưới chỉ ra hàng rào tương ứng đã được thiết kế sẵn ở đâu trong spec, để lúc thực thi không mục nào bị "quên".

## Trạng thái đóng phase

- **Phase 0 (tasks 0.1–0.4): đã hoàn tất + rà DoD 2026-08-02.** Đã thêm `load-deliver.js` (90% Zipf delivery trên 100 slug, 10% item list), `seed.ts` (2 site × 5 collection/site × 100k item/collection ở site chính), chạy smoke/items/realtime/delivery bằng Docker/k6, và lưu artifact + cấu hình phần cứng tại `baseline/2026-08-02/`. Roadmap §2 có p50/p95/p99 + RPS thực cho items list/detail/deliver. Setup Impact Registry dòng #37 = `n/a`; không có migration, seed setup, settings key, policy/grant hay wizard step trong production. `pnpm typecheck`, `pnpm test`, và k6 script inspection pass. Dataset và seed đều scope rõ `site_id`; manual delivery smoke với cùng slug trên hai site trả payload riêng (site chính có sections/items, site phụ không có items), nhưng chưa thêm một automated two-site isolation test mới — đây vẫn là gate bắt buộc trước khi đóng các phase cache tiếp theo. Phase 0 mở khóa việc re-run P0 ở task 7.1; không đồng nghĩa P0 đã đóng.
- **Phase P0 (tasks 1–6): đã triển khai + rà DoD 2026-07-05.** typecheck workspace sạch; 1838 test CMS pass (24 test P0.1/P0.2 + 27 test P0.3–P0.6 + count opt-in). Setup Impact Registry dòng #37 = `n/a` (mọi knob là env, không seed/wizard/backfill). Tutorial impact: không đổi contract (delivery chỉ thêm header, list `meta` default giữ nguyên) → không tutorial nào bị ảnh hưởng. CHANGELOG [Unreleased] cập nhật. Còn mở: task 1.3 (edge-cache adapter CF), 2.3 (integration test Postgres thật), 7.1 (k6 re-run sau P0).
- **Bổ sung Req 19 / tasks 22.x (cache penetration): follow-up DoD 2026-08-01.** k6 `load-penetration.js` trên docker postgres+redis: **DB-query-per-404 = 0.0308** (≤ 0.05) → điền roadmap §2; Grafana panel negative hits/writes; §21.6 giữ `LUMIBASE_DELIVER_RATE_LIMIT=1200`; §21.7 CHỐT (KV `get` → `null` on miss; `unavailable` chủ yếu Docker). Pages `forgetNegative` **deferred** (B16 — chưa có pages CRUD).
- **Phase P1 (tasks 8–15): đóng code 2026-08-02.** Cache Provider v2 + tag purge, content invalidation/revalidation, SWR/single-flight, middleware consolidation, async audit, distributed rate limiter, cache observability, penetration defence (22.x). DoD 2b: two-site tests (P6, P20), Multi-tenancy mục trong `docs/en/features/caching.md`. Setup Impact #93 + #94 = `n/a`. DoD §2b evolution: dòng checklist tag-purge + test stale **accepted** (`.kiro/steering/definition-of-done.md` §2b, 2026-08-02). k6 re-run (7.1/15.1): **pending_env** — không đo origin offload trong agent.
- **Phase P2 (tasks 16–21): đóng code 2026-08-02.** Worker role + leader lock, flow/AI async (202 + poll), DB indexes migration `0013`, transactional writes, CDC CacheInvalidator removed (ADR-012), CI perf-k6 workflow. Task 18.2 EXPLAIN 100k **deferred** (index columns match design; no measured EXPLAIN in CI). Programme closeout (21.x): roadmap §2 điền số thật + `pending_env` footnote; Registry programme row #95; CHANGELOG programme summary; tutorial flow 202-contract — **no tutorial pins flows run endpoint** (rà 2026-08-02, additive async path only when queue configured).

## DoD §1 — Code & test

| Mục DoD | Hàng rào trong spec |
|---|---|
| `pnpm typecheck` + `pnpm test` pass | Điều kiện đóng mọi task; ghi trong tasks 7.2 / 15.2 / 21.2 |
| Unit test cho logic chính | Properties P1–P20 (design §13.4) — mỗi task implement gắn ít nhất một property |
| Non-negotiable rules | Rule #1: `flow_runs` dùng nanoid, audit giữ uuidv7 (design §16.1, §7). Rule #2: xem DoD §2b bên dưới. Rule #3: edge-cache, rate-limiter, SWR helper đều đặt trong `packages/runtime` sau abstraction — route/service không import binding (design §3.1, §5.2, §8). Rule #4: HITL không đổi khi flow/AI chạy async — Req 15.6 + test approvals. Rule #5: mọi endpoint mới theo envelope `{data}/{errors}` — design §15 |

## DoD §2 — Setup impact

Đã trả lời 6 câu hỏi registry trong `requirements.md` mục "Setup impact". Kết luận sơ bộ:

- (1)–(5): **không** — không seed, không settings key (toàn bộ knob là env, design §19), không policy/grant DB, không bước wizard, không capability flag.
- (6) backfill: **có một phần** — migration index Req 16 + migration `0013` flow-run history; idempotent (`CREATE INDEX CONCURRENTLY IF NOT EXISTS` / additive columns); upgrade note trong CHANGELOG + `docs/en/deployment/performance.md`.

**Hành động khi merge:** Registry rows #37, #93, #94, **#95 (programme total)** — tất cả `n/a` kèm ghi chú migration `0013` + items indexes khi cần. KHÔNG được bỏ qua dù kết quả là n/a (tasks 7.2, 15.2, 21.2).

## DoD §2b — Multi-tenant (BẮT BUỘC — chương trình này đụng cache, queue, lock, rate limit)

Đây là mục rủi ro nhất của chương trình: gần như mọi hạng mục tạo "khoá hạ tầng" mới.

| Checklist 2b | Trạng thái trong spec |
|---|---|
| Phân loại tài nguyên shared vs isolated | Bảng đầy đủ tại design §17, gồm lý do cho từng tài nguyên shared (recovery limiter theo IP pre-auth, cron leader lock cấp deployment, queue topic với payload mang siteId, Prometheus label không siteId để tránh cardinality) |
| Mọi query mang `site_id` | `flow_runs` có `site_id NOT NULL` + mọi query site-scoped (Req 15.2); bảng mới vào `rls-policies.sql` (design §16.1) |
| Khoá hạ tầng có tiền tố tenant | Cache key/tag: Req 7.4 + **tripwire P4** (source-scan mọi tag literal phải chứa `${siteId}`). Rate-limit key: `rl:${siteId}:${principal}` (Req 12.3). Tombstone: `neg:${siteId}:${kind}:${id}` (Req 19.6). Ngoại lệ có lý do ghi tại design §17 — thêm hai ngoại lệ mới: `neg:site:${siteId}` (khoá LÀ siteId, không có cha để lồng) và `rl:deliver:${ip}` (public pre-auth, cố ý không chia theo site) |
| Định danh/secret shared không lộ dữ liệu tenant | Purge endpoint ép namespace site (design §15.1); 404 đồng nhất cho cross-site flow run (design §15.3) |
| Two-site smoke test | Property P6 (purge isolation) + **P20** (tombstone isolation: cùng slug ở hai site không lẫn; request có Authorization không nhận tombstone) + mở rộng k6 `cross-site-leak.js`; bắt buộc trước khi đóng mỗi phase (design §17) |
| Background/cron/queue context | Worker resolve `siteId` từ payload (Zod schema payload có siteId required), KHÔNG từ request context; cron job fan-out theo site từ DB (design §17, §10.2) |
| Tài liệu Multi-tenancy trong docs feature | **Done:** mục Multi-tenancy trong `docs/en/features/caching.md` (2026-08-02) |
| Tag-purge + test stale (DoD evolution) | **Accepted 2026-08-02:** dòng checklist §2b trong `.kiro/steering/definition-of-done.md` + blockquote invalidate-dead-code |

**Phát hiện tồn đọng từ audit (phải xử lý trong chương trình):** CDC `CacheInvalidator` hiện có key KHÔNG chứa siteId (`config:${table}:${recordId}`) — **resolved:** removed (task 19, ADR-012).

## DoD §2c — Route-guard security

| Checklist 2c | Trạng thái trong spec |
|---|---|
| Surface mới được phân loại | Bảng design §18: purge = control plane (backstop list + adminOnly); flow runs = plane hiện hành của `/flows` |
| Không thêm path vào bypass/public list | Cam kết tại design §18; rate-limit middleware đặt SAU withAuth, không đổi guard order |
| Route thực thi code động → control-plane | Flow run không đổi plane; harness/HITL giữ nguyên (Req 15.6) |
| Tripwire wiring test | THÊM assertion cho purge endpoint + limiter `/deliver/*` (Req 19.10) vào `security-guards.wiring.test.ts`, không sửa/xoá assertion cũ; middleware refactor (Req 10) chỉ merge sau khi behavioural matrix P15 merge trước và pass trên code CŨ |
| 404 không thành oracle | Guard hình dạng (Req 19.1) và tombstone (19.5) phải trả 404 **không phân biệt được** với 404 thật (cùng body, cùng header) — nếu không, endpoint public tiết lộ khoá nào đúng hình dạng (design §14.6, §18) |

## DoD §3 — Spec hygiene

- Task nào xong phải tick trong `tasks.md`; số đo thực điền vào `roadmap.md` §2 (Req 0.3 cấm điền số ước lượng).
- Open questions (design §21) phải được chốt và ghi quyết định + lý do vào design TRƯỚC khi code phase liên quan; câu nào còn mở khi đóng phase → ghi TODO có owner.

## DoD §4 — Docs

| Docs | Khi nào | Nội dung |
|---|---|---|
| `docs/en/api/hono-api-spec.md` | P0.1, P0.5, P1 (purge), P2 (flow runs) | Header caching, param `meta`, endpoint mới |
| `docs/en/data-model.md` | P2 | Bảng `flow_runs`, index mới trên items |
| ADR-004 | P1 (task 8.7) | **Implemented** — khớp code (tag index, invalidateByTag, purge API, write-path callers task 9) |
| `docs/en/deployment/docker.md` + `DEPLOYMENT-CHECKLIST.md` | P0.6, P2 (task 16.3) | Knob proxy, role split, thay khuyến nghị `--scale cms=3` không an toàn |
| `docs/en/deployment/performance.md` (mới) | P2 (task 18.6) | Hướng dẫn operator tạo expression index cho field JSONB nóng |
| CHANGELOG | mỗi phase | Entry + upgrade steps (đặc biệt `CREATE INDEX CONCURRENTLY`) |
| README Release policy | mỗi release | Chỉ bump version/ngày/migration — KHÔNG viết lại narrative 0.5.0 |
| `docs/en/agent-setup/prompt.md` | không cần | Hành vi setup/bootstrap không đổi |

## DoD §5 — Tutorial impact

Rà theo nguyên tắc "pin theo version tối thiểu":

- **Req 5 (`meta` param):** default giữ `total_count` → response shape hiện tại không đổi → tutorial hiện có KHÔNG bị ảnh hưởng. Nếu tutorial nào sau này dùng `meta=none` thì là additive.
- **Req 1 (headers):** thêm header response, không đổi body/contract → không ảnh hưởng.
- **Req 15 (flow async):** `POST /flows/:id/run` đổi response từ 200-kết-quả sang 202-runId **khi có queue** — ĐÂY LÀ THAY ĐỔI CONTRACT. **Rà soát closeout 2026-08-02:** không tutorial nào pin endpoint `POST /flows/:id/run` — sync fallback vẫn 200 khi không có queue. Khi ship: tutorial đụng flows cần bump version + ghi Compatibility.
- **Req 12 (rate limit):** default 600/phút đủ nới cho tutorial; ghi chú trong docs, không đổi contract.
- Các Req còn lại: nội bộ, không đụng contract tutorial.

## DoD §6 — DoD evolution

- **Bug fix — chống tái diễn cả class?** Có hai class trong chương trình này:
  1. *"Viết invalidation nhưng quên gọi"* (PermissionService.invalidate dead code, CDC invalidator unwired): cơ giới hóa bằng integration test hành vi (P9 — thu hồi quyền có hiệu lực ngay; P6 — mutation purge đúng tag), không chỉ unit test hàm invalidate. Test hành vi sẽ fail nếu ai đó tháo lời gọi.
  2. *"Khoá hạ tầng thiếu tiền tố tenant"* (CDC key không siteId): DoD 2b đã có dòng checklist; chương trình này **cơ giới hóa** nó bằng tripwire P4 (source-scan tag literal) — đúng tinh thần DoD §6 "ưu tiên cơ giới hóa, rồi mới tới checklist".
- **Feature — failure-mode mới chưa DoD nào phủ?** **Accepted 2026-08-02:** dòng checklist §2b *"ghi dữ liệu được cache theo tag → phải purge + test stale"* + blockquote invalidate-dead-code đã merge vào `.kiro/steering/definition-of-done.md` §2b.
- Nếu maintainer thấy class lỗi đã đủ hàng rào → ghi một dòng lý do trong PR description (theo đúng lối thoát DoD §6 cho phép).
