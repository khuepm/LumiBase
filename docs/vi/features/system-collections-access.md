---
version: 1
lastUpdated: 2026-08-02T19:11:44.060Z
sourceLang: en
translatedFrom: en
sourceHash: 3b3decebac998a79
mtEngine: manual
syncStatus: human-translated
<!-- check-parity: allow inline-code -->
---

# System Collections & Sensitive Access Contract

Ngày chốt: 2026-06-03.

Tài liệu này là contract cho:

- seed quyền hệ thống;
- Permission Builder UI grouping;
- import/export access config;
- checklist bảo mật khi thêm bảng system mới.

Nguồn: `packages/database/src/schema/*`.

## Principles

1. Không coi system collection như content collection mặc định.
2. Public policy không được grant system collection trừ khi explicit và đã review.
3. Sensitive collections không hiển thị cho non-admin trong Permission Builder.
4. Permission Builder phải phân nhóm system collections để admin hiểu blast radius.
5. Khi thêm bảng system mới, phải phân loại vào tài liệu này trước khi seed production.
6. Các bảng chứa secret/hash/token/audit/security state chỉ cho `policy_admin` hoặc policy security chuyên dụng.

## Standard Seed Policy Keys

| Policy key | Mục tiêu |
|---|---|
| `policy_admin` | Admin bypass, app access, enforce TFA. |
| `policy_access_manager` | Quản lý roles, policies, permissions, user-role/user-policy binding. |
| `policy_schema_manager` | Quản lý collections, fields, relations, materialized collections. |
| `policy_user_manager` | Quản lý users, teams, membership, notifications khi cần. |
| `policy_security_manager` | Đọc audit/security logs, quản lý lockout/recovery/SCIM/API keys. |
| `policy_automation_manager` | Quản lý flows, operations, webhooks, CDC pipelines. |
| `policy_extension_manager` | Cài/enable/config/grant capability cho extensions. |
| `policy_ai_manager` | Quản lý AI approvals/conversations/embeddings theo feature. |
| `policy_studio_self` | User đăng nhập Studio: đọc/update profile, notifications, presets của chính mình. |
| `policy_public` | Không app access; chỉ grant content public explicit. |

## Current Classification

| Nhóm UI | Collections | Hiển thị trong Permission Builder | Seed mặc định | Ghi chú |
|---|---|---|---|---|
| Tenant root | `sites` | Admin only | `policy_admin` | Instance/site metadata; tránh non-admin sửa domain/site root. |
| Identity | `users`, `user_sites`, `user_roles`, `teams`, `team_members`, `notifications` | Access/User manager | `policy_user_manager`, `policy_studio_self` | `policy_studio_self` chỉ được đọc/update chính mình và notifications/presets của chính mình. |
| Access control | `roles`, `policies`, `role_policies`, `user_policies`, `permissions` | Access manager | `policy_access_manager` | Thay đổi ở đây có thể mở toàn site; luôn audit. |
| Schema builder | `collections`, `fields`, `relations`, `materialized_collections` | Schema manager | `policy_schema_manager` | Cho phép quản lý data model; không nên gộp với editor content thường. |
| Content store | `items`, `pages`, `revisions`, `activity` | Per content role | Per role/project | `items/pages` theo role nội dung; `revisions/activity` nên read-only trừ admin. |
| Files & assets | `folders`, `files` | Per content role / asset manager | Per role/project | File metadata có thể chứa PII; public phải explicit. |
| UX state | `presets`, `translations`, `settings` | Studio/self + manager | `policy_studio_self`, manager policies | `settings` là config-sensitive; chỉ settings manager/admin ghi. |
| Automation | `flows`, `flow_runs`, `operations`, `webhooks` | Automation manager | `policy_automation_manager` | Webhook secret/header là sensitive; non-admin không thấy secret. |
| Extensions | `extensions` | Extension manager | `policy_extension_manager` | Grant capability/install/enable/delete là privileged. |
| Translation memory | `translation_memory`, `glossary` | Translation manager | Dedicated translation policy | Có thể chứa nội dung nội bộ; không public mặc định. |
| AI | `ai_approvals`, `ai_conversations`, `ai_messages`, `ai_embeddings` | AI manager / owner scoped | `policy_ai_manager` | Conversations/messages có thể chứa PII hoặc secrets do user nhập. |
| CDC | `cdc_pipelines`, `cdc_pipeline_health`, `cdc_deployments` | Automation/ops manager | Automation hoặc ops policy | Pipeline connection/env config là sensitive. |
| Security sensitive | `system_state`, `audit_log`, `login_attempts`, `login_baselines`, `admin_backup_codes`, `scim_tokens` | Hidden for non-admin | `policy_admin`, `policy_security_manager` | Không hiển thị cho non-admin; không public; không export secrets. |

## Sensitive Collections Hard Rule

Các collection sau là **sensitive/admin-only**:

```txt
system_state
audit_log
login_attempts
login_baselines
admin_backup_codes
scim_tokens
```

Future sensitive collections:

```txt
api_keys
api_key_roles
api_key_policies
shares
extension_access_policies
```

Rules:

- Permission Builder UI ẩn khỏi non-admin.
- Seed chỉ grant cho `policy_admin` hoặc policy manager chuyên dụng.
- Export/import không chứa plaintext secret/token/hash material.
- Nếu cần cho security manager đọc, dùng read-only và field mask.

## Future Virtual/System Access Targets

Các target này có thể không phải bảng DB trực tiếp nhưng phải xuất hiện trong Permission Builder:

| Target | Mục tiêu |
|---|---|
| `extension_modules` | Quyền thấy module extension trong Module Bar. |
| `extension_endpoints` | Quyền gọi endpoint extension. |
| `extension_operations` | Quyền chạy operation extension/flow node. |
| `api_keys` | Quản lý API key lifecycle. |
| `shares` | Quản lý share link. |
| `admin_security` | Unlock user, unblock IP, recovery/audit security actions. |

## Minimum Seed

Seed local/staging/prod tối thiểu:

1. `role_administrator` + `policy_admin`.
2. `policy_access_manager`.
3. `policy_schema_manager`.
4. `policy_studio_self`.
5. `policy_public` rỗng hoặc chỉ explicit public content.

Không seed:

- public read all content;
- public/system collections;
- plaintext API/static token;
- non-admin write vào access/security collections.

## Checklist For New System Collections

1. Thêm collection vào bảng phân loại ở tài liệu này.
2. Chọn seed policy owner.
3. Xác định có hidden khỏi non-admin không.
4. Xác định import/export có cần mask secret không.
5. Thêm test public policy không đọc được nếu collection sensitive.
