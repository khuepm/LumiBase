---
version: 1
lastUpdated: 2026-07-28T11:42:32.998Z
sourceLang: en
translatedFrom: en
sourceHash: 69dad91518affbf1
mtEngine: claude
syncStatus: machine-translated
---

# App enterprise riêng tư qua git submodule

Hướng dẫn này thiết lập `apps/enterprise/` thành một app **chỉ-riêng-tư**: source
của nó nằm ở một repo private riêng và được mount vào monorepo công khai dưới dạng
một git submodule. Repo công khai chỉ lưu một con trỏ commit — không bao giờ lưu
source.

> Vì sao dùng submodule (mà không phải một private npm registry)? Các package
> `@lumibase/*` đều `private: true` và được tiêu thụ qua `workspace:*`. Submodule
> giữ nguyên điều đó: khi đã checkout, app enterprise chỉ là một workspace `apps/*`
> như mọi cái khác.

## Cấu hình hiện tại trong repo này

Việc này đã được nối sẵn (`.gitmodules` → submodule `apps/enterprise`):

- **Repo private:** `https://github.com/lumibase-ai/enterprise-core.git`
- **Branch được track:** `feat/custom-domains-docs` (branch mặc định của repo đó —
  nó không có `main`)
- **Path:** `apps/enterprise/` (khớp với glob workspace `apps/*`)

Hành vi đã được kiểm chứng khi submodule **vắng mặt** (checkout công khai / CI):
`pnpm install --frozen-lockfile` chạy thành công và đơn giản là bỏ qua thư mục
`apps/enterprise/` rỗng (workspace giảm từ 18 → 17 project, không lỗi). Nên
`actions/checkout@v5` với mặc định `submodules: false` không cần đổi gì — CI công
khai install sạch sẽ mà không bao giờ chạm tới repo private.

Mục 1–2 bên dưới là công thức chung (đã được thực hiện cho repo này); hãy giữ
chúng để tham khảo, hoặc khi cần chuyển submodule sang chỗ khác.

## Mô hình mối đe doạ / quy tắc về ranh giới

- **Phụ thuộc một chiều:** chỉ `enterprise → core`. Code core (`cms`, `studio`,
  `packages/*`) không bao giờ được `import '@lumibase/enterprise'`, nếu không
  **build công khai sẽ vỡ** (submodule vắng mặt trong các checkout công khai).
- `.gitmodules` được commit vào repo **công khai** và phơi ra **URL** của repo
  private. Điều đó chấp nhận được — một URL không phải credential; clone vẫn cần
  quyền truy cập repo.
- **CI công khai không được fetch submodule.** `actions/checkout` mặc định là
  `submodules: false` — hãy giữ như vậy cho mọi workflow công khai. Chỉ job build
  private/self-hosted mới fetch nó (kèm một token).

---

## 1. Tạo repo private

Tạo một repo **private rỗng**, ví dụ `your-org/lumibase-enterprise`. Chuyển nội
dung `apps/enterprise/` đã scaffold vào đó, làm gốc của repo:

```bash
# từ một bản clone mới của repo private (đang rỗng)
git clone git@github.com:your-org/lumibase-enterprise.git
cd lumibase-enterprise
# copy phần scaffold đã được sinh ra trong monorepo:
cp -R /path/to/lumibase/apps/enterprise/. .
git add -A && git commit -m "feat: initial enterprise app"
git push origin main
```

## 2. Thêm nó trở lại monorepo dưới dạng submodule

Trong monorepo **công khai**, thay bản scaffold cục bộ bằng submodule:

```bash
# bỏ bản copy cục bộ trước (giờ nó đã nằm ở repo private)
git rm -r --cached apps/enterprise
rm -rf apps/enterprise

# mount repo private ở cùng path
git submodule add git@github.com:your-org/lumibase-enterprise.git apps/enterprise
git commit -m "chore: mount enterprise app as private submodule"
```

Việc này tạo ra `.gitmodules`:

```ini
[submodule "apps/enterprise"]
	path = apps/enterprise
	url = git@github.com:your-org/lumibase-enterprise.git
```

## 3. Hành vi khi clone

```bash
# Người đóng góp KHÔNG có quyền truy cập (chỉ công khai):
git clone git@github.com:your-org/lumibase.git
#   → apps/enterprise/ là một con trỏ rỗng. pnpm install bỏ qua nó
#     vì bên trong không có package.json. Build công khai vẫn chạy.

# Nhóm CÓ quyền truy cập (build đầy đủ):
git clone --recurse-submodules git@github.com:your-org/lumibase.git
# hoặc, sau một lần clone thường:
git submodule update --init --recursive
#   → apps/enterprise/ được điền đầy; pnpm nhận nó ra như một workspace.
```

`pnpm-workspace.yaml` đã glob `apps/*` và `turbo.json` dùng task glob, nên **không
cần đổi cấu hình gì** trong cả hai trường hợp.

## 4. CI công khai — KHÔNG được fetch submodule

Trong mọi workflow công khai có chạy `actions/checkout`, hãy để submodule tắt (đó
là mặc định). Hãy ghi tường minh để tránh sơ suất:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: false   # không bao giờ fetch submodule private trong CI công khai
```

Khi đó `pnpm install` / `turbo run build` công khai đơn giản là bỏ qua thư mục
`apps/enterprise/` rỗng.

## 5. Job build private / self-hosted (có fetch submodule)

Job này chạy trong repo **private** (hoặc một workflow được bảo vệ, có secret).
Hãy dùng một deploy token / fine-grained PAT có quyền đọc `lumibase-enterprise`:

```yaml
# .github/workflows/enterprise-deploy.yml (private)
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          token: ${{ secrets.ENTERPRISE_SUBMODULE_TOKEN }}
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: pnpm install --ignore-scripts
      - run: pnpm --filter @lumibase/enterprise typecheck
      - run: pnpm --filter @lumibase/enterprise test
      - run: pnpm --filter @lumibase/enterprise build
      - run: pnpm --filter @lumibase/enterprise deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## 6. Hằng ngày: cập nhật con trỏ

```bash
# pull code enterprise mới nhất vào submodule
git submodule update --remote apps/enterprise
git add apps/enterprise
git commit -m "chore: bump enterprise submodule"
```

## 7. Enforce ranh giới một chiều (khuyến nghị)

Hãy thêm một guard trong CI công khai để không ai vô tình import app enterprise từ
code core:

```bash
# fail nếu có source core nào import @lumibase/enterprise
! grep -rES "from ['\"]@lumibase/enterprise" \
    apps/cms apps/studio packages \
  || { echo "core must not import @lumibase/enterprise"; exit 1; }
```

## 8. Cloudflare Pages (và các builder tích hợp Git khác)

> ⚠️ **Cái bẫy sẽ làm vỡ các bản deploy Pages của bạn.** Tích hợp Git của
> Cloudflare Pages **clone submodule theo mặc định** khi build. Nó không có
> credential cho repo private `enterprise-core`, nên mọi Pages project đều fail ở
> stage *Building* — đã kiểm chứng: `lumibase-docs`, `lumibase-landing`, và
> `lumibase-marketplace` đều chuyển từ success → failure ở đúng commit đưa
> submodule vào, và đều xanh ở commit cha của nó.

**Cách sửa — một toggle trên dashboard, không phải một file trong repo** (không có
setting `wrangler.toml` / `.cloudflare` nào cho việc này). Với **từng** Pages
project bị ảnh hưởng:

1. Cloudflare Dashboard → **Workers & Pages** → chọn project.
2. **Settings** → **Builds & deployments** (còn gọi là *Build configuration*).
3. Tắt **"Include submodules when cloning"**.
4. Lưu lại, rồi **Retry deployment** trên build đã fail.

Việc này an toàn vì không Pages app nào import `@lumibase/enterprise` (hãy guard
nó y như §7 nếu bạn muốn CI enforce điều đó):

```bash
# fail nếu có Pages app nào tham chiếu tới submodule enterprise
! grep -rES "@lumibase/enterprise|apps/enterprise" \
    apps/docs apps/landing apps/marketplace \
  || { echo "Pages apps must not reference apps/enterprise"; exit 1; }
```

Điều tương tự áp dụng cho **bất kỳ** builder bên ngoài nào clone qua tích hợp Git
(Vercel, Netlify, Amplify): hoặc tắt việc fetch submodule, hoặc cấp cho nó một
token đọc repo private.

---

## Tóm lại

| Vấn đề | Repo công khai | Repo private / nhóm |
| --- | --- | --- |
| Source có thấy được? | Không (con trỏ rỗng) | Có |
| `pnpm install` | Bỏ qua thư mục rỗng | Coi như một workspace |
| CI checkout | `submodules: false` | `submodules: recursive` + token |
| Cloudflare Pages | Tắt "Include submodules when cloning" | n/a |
| Deploy | n/a | `wrangler deploy --env production` |
