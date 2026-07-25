# v1.0.0 — Phân loại specs in-v1 / post-v1

> Thực thi mục **2. Scope freeze** của `v1-release-criteria.md`: mọi spec trong `.kiro/specs/` được phân loại **in-v1** (đã ship, thuộc surface 1.0) hoặc **post-v1** (roadmap sau 1.0). Căn cứ: Implementation-status footer + tasks.md + đối chiếu code (khảo sát 2026-07-16 tại v0.23.0), không tin checkbox đơn thuần. File này là quyết định scope chính thức cho tag `v1.0.0`; item post-v1 chỉ được ship ở bản minor sau theo semver (additive-only).
>
> **Reconcile 2026-07-25 (tại v0.24.1, 38 specs):** ba spec trước đây không nằm ở nhóm nào đã được phân loại — `graphql-cost-limit` và `setup-complete-rate-brake` (cả hai 20/20 task, code + test có trên main) vào nhóm hoàn tất; `idempotency-keys` (0/29 task) vào nhóm proposal. Và `high-load-cache-readiness` chuyển từ "không còn việc mở" sang nhóm deferral: P0 đã ship thật nhưng tasks.md còn 83 item mở thuộc baseline đo đạc + P1/P2, nên xếp "không còn việc mở" là sai. Không mục nào trong lần reconcile này chặn tag.

## In-v1 — hoàn tất, không còn việc mở

admin-setup-wizard · ai-first-cms-engine · auth-session-hardening · clickhouse-cdc · code-first-config · content-os · content-os-ui · content-versioning · docker-dual-deployment · external-jwt-auth · fk-dependent-records · graphql-cost-limit · image-transform-dsl · insights-dashboard · lumibase-docs-i18n · lumibase-docs-viewer · presets-inheritance · realtime-audience-channels · realtime-subscriptions · regulated-content-readiness · setup-complete-rate-brake · studio-ops-ui · translation-memory-ui · visual-flow-builder

## In-v1 — hoàn tất, có deferral chính thức (ship sau ở 1.x)

Core của spec đã ship và thuộc surface 1.0; các item dưới đây chuyển thành backlog 1.x. Không item nào đổi shape surface đã freeze — phần thêm mới đều additive (ví dụ endpoint `POST /api/v1/utils/cache/purge` ở task 8.6 của `high-load-cache-readiness`), hợp semver cho bản minor.

Phần lớn item hoãn đã được ghi rõ trong chính spec. Ngoại lệ là `high-load-cache-readiness`: các item của nó chỉ đang unchecked trong `tasks.md` chứ chưa có tuyên bố hoãn trong spec — quyết định hoãn nằm ở chính dòng dưới đây, và nó không chặn tag vì thuộc nhóm performance baseline/load test mà `v1-release-criteria.md` §7 đã xếp "nên có, không chặn tag".

| Spec | Item hoãn (post-v1) |
|---|---|
| cdc-extension-integration | OpenAPI/SDK typed resources cho change feed |
| json-field-search | Type-aware cast khi search JSON field ("HOÃN v2") |
| save-default-preference | Component test cho preference UI |
| content-releases | Zod schemas bổ sung cho release payload |
| git-integration | 3.3 validateProductionConfig · 4.7 CRUD integration test (cần Postgres) · 12.1 notification dispatcher · 13.3 schema apply qua HITL + YAML · 14.3 git-sync agent loop |
| upload-file-controls | F1 re-encode ảnh chống polyglot · F2 ClamAV (optional, regulated tenants) · F3 per-field `accept` UI |
| high-load-cache-readiness | **P0 đã ship** (ETag + `Cache-Control` cho Delivery API, permission-cache key versioning + bump tại mutation quyền, API-key `lastUsedAt` debounce, setup-state process cache, `meta=total_count` opt-in trên list, proxy/body limits). **Hoãn:** task 0 baseline đo đạc + 7.1/15.1/21.1 re-run k6 (cần môi trường tải, không chạy được trong CI hiện tại) · 1.3 `runtime.edgeCache` adapter · 2.3 integration test permission-revoke với Postgres thật · **P1 (task 8–15)** Cache Provider v2 tag/purge, content invalidation + revalidation, single-flight/SWR, middleware consolidation, async audit, distributed rate limiter, cache observability · **P2 (task 16–21)** worker role + leader lock, flow/AI async, DB index + transactional writes, CDC CacheInvalidator resolution, CI perf gate |

## Post-v1 — có việc mở thật, KHÔNG chặn tag (quyết định scope)

| Spec | Trạng thái | Quyết định |
|---|---|---|
| deployment-integrations | PARTIAL: rate-limit cho deploy hooks (Open) · idempotency test (Partial) · HMAC/JWS webhook signing (Partial) | Core deploy-hooks đã ship trong 0.x và giữ nguyên contract; 3 item còn lại là hardening additive → ship ở 1.x. Webhook signing là security-hardening ưu tiên cao nhất của nhóm này — đưa lên đầu backlog 1.1. |

## Post-v1 — proposal/roadmap, chưa bắt đầu

collection-create-modes · tenant-localization-config · db-view-introspection · cdc-feed-roadmap · idempotency-keys · project-configuration (chỉ có design.md)

Không spec nào trong nhóm này reserve public surface trong code (khác M2A — đã tuyên bố out-of-scope trong `docs/en/contributing/versioning-policy.md` và trả 501 `RELATION_TYPE_NOT_IMPLEMENTED`). Đã verify riêng cho `idempotency-keys`: không có chỗ nào trong `apps/`/`packages/` đọc header `Idempotency-Key` và không có bảng schema tương ứng, nên header này là surface **hoàn toàn mới** khi ship ở 1.x — additive, không phá contract 1.0.

---

**Hệ quả cho release:** không còn spec nào ở trạng thái "mập mờ". Mọi việc mở đều là (a) deferral đã ghi trong spec, hoặc (b) quyết định post-v1 ở bảng trên. Khi cắt RC, đối chiếu lại file này lần cuối; sau tag, chuyển hai bảng post-v1 thành backlog 1.x trong roadmap.
