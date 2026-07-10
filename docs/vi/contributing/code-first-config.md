---
version: 1
lastUpdated: 2026-07-08T20:22:55.993Z
sourceLang: en
translatedFrom: en
sourceHash: a88561e009df6196
mtEngine: claude
syncStatus: machine-translated
---

# Code-First Configuration

LumiBase có thể export **schema configuration** của một site — collections, fields,
relations, settings và webhooks — dưới dạng một manifest JSON khai báo duy nhất
(`lumibase.config@v1`). Commit manifest vào git, review thay đổi trong pull
request, rồi apply nó qua các environment để phục vụ CI/CD và đồng bộ environment.
Cách này phản ánh cơ chế schema snapshot/apply của Directus, được xây dựng trên
core multi-tenant, runtime-abstracted của LumiBase.

> **Phạm vi.** Manifest chỉ bao gồm *schema config*. Nó cố ý loại trừ:
> content items (đó là dữ liệu), access control (dùng `/api/v1/access/*`), và mọi
> secret/credential (không bao giờ được serialize). Manifest an toàn để commit — nó
> không chứa `id`, `siteId`, timestamps hay hashes.

## Manifest

Một tài liệu JSON chuẩn tắc, dễ diff. Các resource được key theo những key ổn định,
có ý nghĩa với con người (collection `name`, `collection.field`,
`manyCollection.manyField`) thay vì id sinh tự động, và các mảng được sắp xếp sao cho
hai lần export cùng một trạng thái sẽ giống hệt nhau tới từng byte.

```jsonc
{
  "version": "lumibase.config@v1",
  "collections": [{ "name": "articles", "label": "Articles", "versioning": true }],
  "fields": [{ "collection": "articles", "field": "title", "type": "string", "interface": "input" }],
  "relations": [{ "manyCollection": "articles", "manyField": "author", "oneCollection": "users", "onDelete": "set null" }],
  "webhooks": [],
  "settings": [{ "key": "login_security_policy", "value": { /* … */ } }],
  "managedScopes": ["articles"]   // optional — see replace-managed below
}
```

## CLI

```bash
# Export the live config to a file (commit this to git)
pnpm --filter @lumibase/cms config export --site <siteId> --out config.json

# Diff a manifest against the live instance — exit 1 if changes are pending
pnpm --filter @lumibase/cms config diff --site <siteId> config.json

# Apply a manifest
pnpm --filter @lumibase/cms config apply --site <siteId> config.json --mode merge
```

Environment: `LUMIBASE_API_URL` (mặc định `http://localhost:1989`) và
`LUMIBASE_TOKEN` (một admin bearer token).

## Apply modes

| Mode | Tạo / cập nhật | Xóa |
|------|-------------------|---------|
| `merge` (mặc định) | ✅ | ❌ không bao giờ |
| `replace-managed` | ✅ | chỉ resource nằm trong `managedScopes` |
| `replace-all` | ✅ | bất cứ thứ gì vắng mặt trong manifest (full sync) |

**Destructive guard.** Việc drop một collection hay field đang giữ dữ liệu, thay đổi
`type` của một field, hoặc mở rộng `onDelete` của một relation thành `cascade` được
phân loại là rủi ro `high` và bị **chặn** trừ khi bạn truyền `--allow-destructive` (CLI) /
`?allowDestructive=true` (API). Một dry-run luôn *hiển thị* các thay đổi destructive để
bạn có thể review chúng trong CI trước khi cho phép.

**Atomicity.** Một lần apply chạy bên trong một database transaction duy nhất. Nếu bất
kỳ bước nào thất bại, toàn bộ manifest được rollback — instance không bao giờ bị để lại
ở trạng thái apply nửa vời.

## Recommended CI/CD workflow

1. **Author** các thay đổi schema trong một branch (qua Studio hoặc API).
2. **Export** và commit manifest:
   `config export --site $SITE --out config.json`.
3. **Gate the PR**: trong CI, chạy `config diff --site $STAGING config.json`. Một
   exit khác 0 nghĩa là branch đã lệch khỏi staging — hiển thị diff để
   review.
4. **Promote**: khi merge, chạy
   `config apply --site $PROD config.json --mode replace-managed` (hoặc
   `replace-all` cho một environment fully-managed), chỉ thêm `--allow-destructive`
   khi diff đã review có chủ đích xóa dữ liệu.

## Round-trip guarantee

Export một site rồi ngay lập tức re-import nó (`--mode replace-all --dry-run`)
cho ra một diff sạch với tất cả trạng thái `unchanged`. Manifest là một biểu diễn
trung thực, không mất mát của schema config của site — được xác minh bởi một property test
(`config-serialize.test.ts`) và một DB-backed round-trip test
(`config-import.db.integration.test.ts`).

## Limitations (v1)

- Việc xóa với `replace-managed` được giới hạn phạm vi theo tên collection qua `managedScopes`
  (không theo từng field). Để full sync, dùng `replace-all`.
- Webhook URLs được export nguyên văn — đừng commit một manifest mà webhook URL của nó
  nhúng một secret token; hãy ưu tiên header-based auth.
- CLI giao tiếp với một CMS đang chạy qua HTTP; chưa có chế độ offline/in-process.
