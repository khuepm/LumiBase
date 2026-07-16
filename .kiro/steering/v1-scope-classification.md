# v1.0.0 — Phân loại specs in-v1 / post-v1

> Thực thi mục **2. Scope freeze** của `v1-release-criteria.md`: mọi spec trong `.kiro/specs/` được phân loại **in-v1** (đã ship, thuộc surface 1.0) hoặc **post-v1** (roadmap sau 1.0). Căn cứ: Implementation-status footer + tasks.md + đối chiếu code (khảo sát 2026-07-16 tại v0.23.0), không tin checkbox đơn thuần. File này là quyết định scope chính thức cho tag `v1.0.0`; item post-v1 chỉ được ship ở bản minor sau theo semver (additive-only).

## In-v1 — hoàn tất, không còn việc mở

admin-setup-wizard · ai-first-cms-engine · auth-session-hardening · clickhouse-cdc · code-first-config · content-os · content-os-ui · content-versioning · docker-dual-deployment · external-jwt-auth · fk-dependent-records · high-load-cache-readiness · image-transform-dsl · insights-dashboard · lumibase-docs-i18n · lumibase-docs-viewer · presets-inheritance · realtime-audience-channels · realtime-subscriptions · regulated-content-readiness · studio-ops-ui · translation-memory-ui · visual-flow-builder

## In-v1 — hoàn tất, có deferral chính thức (ship sau ở 1.x)

Core của spec đã ship và thuộc surface 1.0; các item dưới đây đã được ghi rõ là hoãn trong chính spec, chuyển thành backlog 1.x. Không item nào đổi shape surface đã freeze.

| Spec | Item hoãn (post-v1) |
|---|---|
| cdc-extension-integration | OpenAPI/SDK typed resources cho change feed |
| json-field-search | Type-aware cast khi search JSON field ("HOÃN v2") |
| save-default-preference | Component test cho preference UI |
| content-releases | Zod schemas bổ sung cho release payload |
| git-integration | 3.3 validateProductionConfig · 4.7 CRUD integration test (cần Postgres) · 12.1 notification dispatcher · 13.3 schema apply qua HITL + YAML · 14.3 git-sync agent loop |
| upload-file-controls | F1 re-encode ảnh chống polyglot · F2 ClamAV (optional, regulated tenants) · F3 per-field `accept` UI |

## Post-v1 — có việc mở thật, KHÔNG chặn tag (quyết định scope)

| Spec | Trạng thái | Quyết định |
|---|---|---|
| deployment-integrations | PARTIAL: rate-limit cho deploy hooks (Open) · idempotency test (Partial) · HMAC/JWS webhook signing (Partial) | Core deploy-hooks đã ship trong 0.x và giữ nguyên contract; 3 item còn lại là hardening additive → ship ở 1.x. Webhook signing là security-hardening ưu tiên cao nhất của nhóm này — đưa lên đầu backlog 1.1. |

## Post-v1 — proposal/roadmap, chưa bắt đầu

collection-create-modes · tenant-localization-config · db-view-introspection · cdc-feed-roadmap · project-configuration (chỉ có design.md)

Không spec nào trong nhóm này reserve public surface trong code (khác M2A — đã tuyên bố out-of-scope trong `docs/en/contributing/versioning-policy.md` và trả 501 `RELATION_TYPE_NOT_IMPLEMENTED`).

---

**Hệ quả cho release:** không còn spec nào ở trạng thái "mập mờ". Mọi việc mở đều là (a) deferral đã ghi trong spec, hoặc (b) quyết định post-v1 ở bảng trên. Khi cắt RC, đối chiếu lại file này lần cuối; sau tag, chuyển hai bảng post-v1 thành backlog 1.x trong roadmap.
