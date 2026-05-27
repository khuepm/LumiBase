# Consumer App & SDK Roadmap

> **Scope:** Xây dựng SDK đa nền tảng và ứng dụng Consumer demo để kiểm thử, đảm bảo public API hoạt động trơn tru.

## Mục tiêu
1. **SDK Composable Architecture**: Lấy cảm hứng từ Directus SDK. SDK có thể mở rộng (`.with(rest())`, `.with(graphql())`), hỗ trợ Typegen.
2. **NPM Package**: Xây dựng build system (tsup) để đóng gói thư viện với định dạng ESM, CJS, DTS chuẩn bị publish.
3. **Consumer Demo**: Ứng dụng Next.js làm ví dụ hướng dẫn sử dụng SDK (fetch data, hiển thị).

## Task Breakdown

### 1. Refactor `@lumibase/sdk`
- [ ] Chuyển đổi kiến trúc sang Composable Client (`createLumiClient().with(...)`).
- [ ] Tách Core Logic ra khỏi Rest Implementation (VD: `src/rest/readItems.ts`).
- [ ] Thiết lập tsup builder, update `package.json` để export các endpoints chuẩn.

### 2. Update Studio CMS
- [ ] Migrate toàn bộ usage của `createLumiClient` cũ sang syntax mới (trong `apps/studio`).

### 3. Khởi tạo Consumer App (`apps/consumer`)
- [ ] Tạo Next.js App Router boilerplate.
- [ ] Tích hợp `@lumibase/sdk`.
- [ ] Demo tính năng fetch items từ một collection bất kỳ thông qua SDK và SSR/CSR.
