---
version: 1
lastUpdated: 2026-07-28T10:18:03.865Z
sourceLang: en
translatedFrom: en
sourceHash: 5acaa937f36c1fe7
mtEngine: claude
syncStatus: machine-translated
---

# Chuyển app marketplace sang submodule

> **Trạng thái: đã áp dụng.** `.gitmodules` đã có entry submodule
> `apps/marketplace`. Trang này được giữ lại như runbook chính thức — để audit
> xem lần chuyển đó đã làm gì, hoặc để lặp lại đúng cách tách này cho một app khác.

Site marketplace công khai (`apps/marketplace`) đã được tách ra repo riêng rồi
gắn lại vào monorepo này dưới dạng git submodule:

- **Repo đích:** `git@github.com:lumibase-ai/marketplace.git`
- **Đường dẫn mount:** `apps/marketplace` (không đổi).
- **Thành viên workspace:** submodule này **cố ý bị loại** khỏi pnpm workspace —
  `pnpm-workspace.yaml` có `- "!apps/marketplace"` sau glob `apps/*`. Nó build
  độc lập với dependency riêng, nên `pnpm-lock.yaml` ở gốc không chứa chúng và
  một lần frozen install ở đây không bao giờ phụ thuộc vào việc submodule đã
  được checkout. CI cài và build nó standalone bên trong `apps/marketplace`.

## Vì sao việc này không tự động

Phần tự động hoá chuẩn bị cho thay đổi này chỉ có scope trong `khuepm/lumibase`
và **không có quyền push** vào `lumibase-ai/*`. Do đó việc tách được giao dưới
dạng một script chạy được — hãy chạy nó từ một máy (hoặc CI) có quyền push vào
`lumibase-ai/marketplace`.

## Điều kiện tiên quyết

1. `lumibase-ai/marketplace` đã tồn tại và đang rỗng (hoặc sẵn sàng nhận một
   `main` mới).
2. Git remote của bạn có quyền push vào đó (SSH key hoặc PAT).
3. Chạy từ một working tree sạch ở gốc repo.

## Chạy nó

```bash
# Dry run — in ra mọi lệnh git mà không thực thi:
./scripts/marketplace-submodule-migration.sh

# Thực thi thật:
APPLY=1 ./scripts/marketplace-submodule-migration.sh

# Thực thi, ghi đè phần scaffolding (README/license) trên main của remote:
FORCE=1 APPLY=1 ./scripts/marketplace-submodule-migration.sh
```

Các env var override được: `MARKETPLACE_REPO_URL`, `MARKETPLACE_BRANCH`, `FORCE`.

### Nếu push bị từ chối ("fetch first" / non-fast-forward)

Repo đích đã có commit trên `main` — gần như luôn là commit `README`/license mà
GitHub tự thêm khi bạn tạo repo qua UI. Lịch sử subtree được tách ra là một root
riêng biệt, nên không thể fast-forward.

- **Bỏ phần scaffolding đó** (an toàn khi `main` chỉ có commit auto-init): chạy
  lại với `FORCE=1` — nó push kèm `--force` (không dùng được
  `--force-with-lease` khi push tới một URL ad-hoc: không có remote-tracking ref
  thì nó luôn từ chối với "stale info").
- **Giữ lịch sử của remote**: push sang một branch phụ rồi hoà giải qua PR:
  ```bash
  git push git@github.com:lumibase-ai/marketplace.git marketplace-export:import-app
  ```

Script dừng lại trước khi chạm vào monorepo, nên một lần push bị từ chối vẫn để
`apps/marketplace` nguyên vẹn — chỉ cần xử lý xong phần push rồi chạy lại.

## Nó làm gì

1. `git subtree split --prefix=apps/marketplace` — tách toàn bộ lịch sử của app
   sang một branch tạm `marketplace-export` (mọi commit từng chạm vào folder đó
   đều được giữ).
2. Push lịch sử đó lên `lumibase-ai/marketplace` dưới dạng `main`.
3. `git rm -r apps/marketplace` rồi commit việc xoá khỏi monorepo.
4. `git submodule add` ở cùng path rồi commit con trỏ submodule.
5. Xoá branch export tạm.

## Sau khi chuyển

- `.gitmodules` liệt kê `extensions`, `apps/marketplace`, và `apps/enterprise`.
- Người đóng góp: chạy `git submodule update --init --recursive` sau khi pull.
- CI: bật checkout submodule (`actions/checkout` với `submodules: recursive`).
- Nâng phiên bản app = commit một SHA submodule mới trong monorepo (hoặc chạy
  `git submodule update --remote`).
