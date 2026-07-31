---
version: 1
lastUpdated: 2026-07-28T11:30:32.359Z
sourceLang: en
translatedFrom: en
sourceHash: 2de385a752cc3cff
mtEngine: claude
syncStatus: machine-translated
---

# Đóng góp cho LumiBase

Cảm ơn bạn đã quan tâm tới việc đóng góp cho LumiBase! Hướng dẫn này nói về cách dựng môi trường phát triển, quy ước code style, yêu cầu về test, và quy trình PR.

## Mục lục

- [Dựng môi trường phát triển](./index.md#dựng-môi-trường-phát-triển)
- [Code style](./code-style.md)
- [Hướng dẫn testing](./testing.md)
- [Viết extension](./extension-dev.md)
- [Chính sách versioning](./versioning-policy.md)
- [Gửi một PR](#gửi-một-pr)

---

## Dựng môi trường phát triển

### Điều kiện tiên quyết

| Tool | Version | Cài đặt |
|------|---------|---------|
| Node.js | ≥ 22 | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| Docker + Docker Compose | Mới nhất | [docker.com](https://docker.com) |
| Git | ≥ 2.40 | Package manager của hệ thống |

### Clone và install

```bash
git clone https://github.com/khuepm/lumibase.git
cd lumibase
pnpm install
```

### Cấu hình environment

```bash
cp .env.example .env
# Sửa .env với giá trị cục bộ của bạn (xem docs/vi/deployment/environment-variables.md)
```

Tối thiểu cần có cho dev cục bộ:
```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/lumibase
LOGTO_ENDPOINT=http://localhost:3001
LOGTO_APP_ID=your-local-logto-app-id
LUMIBASE_RUNTIME=docker
```

### Khởi động hạ tầng

```bash
# Khởi động PostgreSQL + Redis + MeiliSearch + Logto
docker compose -f docker/docker-compose.yml up -d
```

### Chạy database migration

```bash
pnpm -F @lumibase/database db:migrate
```

### Khởi động server phát triển

```bash
pnpm dev
```

Lệnh này khởi động mọi app ở chế độ watch:
- **CMS API** — `http://localhost:1989`
- **Studio** — `http://localhost:2026`
- **Docs viewer** — `http://localhost:5174`

---

## Quy ước của dự án

### Đặt tên branch

```
feat/short-description          # Tính năng mới
fix/short-description           # Sửa bug
docs/short-description          # Chỉ tài liệu
refactor/short-description      # Refactor
chore/short-description         # Tooling, deps, CI
```

### Commit message (Conventional Commits)

```
feat(cms): add bulk item delete endpoint
fix(studio): prevent infinite re-render in field editor
docs(api): expand filter operator reference
chore(deps): update drizzle-orm to 0.32.0
test(ai-harness): add property tests for capability check
```

Định dạng: `type(scope): description`

Các type: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`

### Dependency override & patch

Các pin bảo mật và patch source cho dependency chuyển tiếp nằm dưới key `pnpm` trong `package.json` ở gốc (`overrides` và `patchedDependencies`). Mọi entry **bắt buộc** phải được ghi lại trong [Dependency Overrides & Patches](../security/dependency-overrides.md) kèm lý do và điều kiện để bỏ nó đi. Nếu bạn thêm, đổi, hay bỏ một override hoặc patch, hãy cập nhật registry đó trong cùng PR.

### Checklist cho PR

Trước khi mở một PR, hãy kiểm tra:

- [ ] `pnpm typecheck` pass ở mọi package bị ảnh hưởng
- [ ] `pnpm test` pass (hoặc đã thêm test mới cho hành vi đã đổi)
- [ ] `pnpm lint` pass
- [ ] Đã cập nhật docs nếu thay đổi ảnh hưởng tới public API, cấu hình, hoặc hành vi
- [ ] Mọi thay đổi doc hướng tới người dùng phải xuất hiện ở **cả** `docs/en/` và `docs/vi/` trong cùng một commit, và được đóng dấu bằng `node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified`. Hãy kiểm tra `sourceLang` trong front matter trước — một số doc có nguồn là tiếng Việt, và nếu chỉ sửa phía bản dịch thì nó sẽ bị ghi đè ở lần sync kế tiếp. Xem quy trình i18n trong `CLAUDE.md`
- [ ] Release note có mục `Migrations` cho mọi bản release, kể cả khi nội dung là `None`
- [ ] Database migration tương thích ngược trong ít nhất một cửa sổ release: thêm nullable/default trước, backfill riêng, và hoãn các lần drop phá huỷ sang một release dọn dẹp về sau
- [ ] Tiêu đề PR theo định dạng Conventional Commits
- [ ] Đã cập nhật `docs/en/data-model.md` nếu schema đổi
- [ ] Đã cập nhật `docs/en/security/dependency-overrides.md` nếu một override hoặc patch của `pnpm` đổi
- [ ] Đã thêm ADR nếu có một quyết định kiến trúc đáng kể

---

## Gửi một PR

1. Fork repository và tạo một feature branch
2. Thực hiện thay đổi theo các quy ước ở trên
3. Push lên fork của bạn và mở một PR nhắm vào `main`
4. Điền PR template — mô tả thay đổi, link tới các issue liên quan, và thêm screenshot cho các thay đổi UI
5. Một maintainer sẽ review trong vòng 48 giờ

### Hướng dẫn về kích cỡ PR

- **PR nhỏ** (< 200 dòng thay đổi) — được ưu tiên; dễ review hơn
- **PR lớn** — hãy tách thành các commit hợp lý; thêm một mô tả PR chi tiết giải thích thay đổi tổng thể

### PR có AI hỗ trợ

Nếu bạn dùng một AI agent để sinh code, xin hãy:
- Đọc và hiểu từng dòng trước khi gửi
- Đảm bảo test pass và không phải pass một cách hình thức
- Ghi chú việc có AI hỗ trợ trong mô tả PR (không bắt buộc nhưng rất được hoan nghênh)

---

## Nhận trợ giúp

- **GitHub Discussions** — cho các câu hỏi thiết kế và đề xuất tính năng
- **GitHub Issues** — cho báo cáo bug
- **Discord** — để chat realtime với maintainer (link trong README)
