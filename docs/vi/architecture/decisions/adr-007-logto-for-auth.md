---
version: 1
lastUpdated: 2026-07-05T10:56:37.201Z
sourceLang: en
translatedFrom: en
sourceHash: 63a2d80683a535b3
mtEngine: claude
syncStatus: machine-translated
---

# ADR-007: Logto cho Xác thực

**Date:** 2024-02-01
**Status:** Accepted

## Context

LumiBase cần một giải pháp xác thực hỗ trợ:

1. **Đa tenant** — các site khác nhau có người dùng khác nhau; một `admin@siteA.com` không được phép truy cập Site B
2. **OIDC/OAuth2** — các giao thức chuẩn để tích hợp SSO với các nhà cung cấp danh tính doanh nghiệp (Google Workspace, Microsoft Entra, Okta)
3. **Luồng mời** — admin mời người dùng qua email; người dùng đặt mật khẩu qua một liên kết đã ký
4. **Tùy chọn tự host** — với triển khai Docker, xác thực không thể phụ thuộc vào một SaaS bên thứ ba có thể không khả dụng
5. **Nhẹ** — không nên đòi hỏi một máy chủ xác thực nặng ở chế độ Cloudflare Workers

Các phương án đã cân nhắc:
- **Supabase Auth** — gắn chặt với PostgreSQL, không dễ đa tenant theo từng site
- **Auth.js (NextAuth)** — tập trung vào React/Next.js, không phù hợp cho một Hono API độc lập
- **Keycloak** — rất nặng, dựa trên Java, không thân thiện với Docker cho các setup tự host nhỏ
- **Logto** — OIDC-native, đa tenant, mã nguồn mở, triển khai được bằng Docker, dấu chân tối thiểu
- **Custom JWT** — kiểm soát tối đa nhưng gánh nặng hiện thực đáng kể (MFA, PKCE, xoay token, v.v.)

## Decision

Dùng **Logto** làm nhà cung cấp xác thực chính.

Mẫu tích hợp:
- Logto phát hành JWT với các claim OIDC chuẩn
- `apps/cms` validate JWT ở edge bằng JWKS (`/.well-known/jwks.json` từ Logto), được cache qua `CacheProvider`
- Metadata người dùng (gán site, roles, capabilities) được lưu trong bảng `users` của chính LumiBase, liên kết qua claim subject (`sub`) của Logto
- Middleware `withAuth()` validate JWT và nạp bản ghi người dùng LumiBase vào context

Với Docker tự host: Logto chạy như một container Docker cùng với LumiBase CMS.
Với Cloudflare Workers: dùng Logto Cloud (hoặc một instance Logto tự host).

Cấp phát SCIM 2.0 (cho SSO doanh nghiệp) dùng một `SCIM_TOKEN` riêng — không phải pipeline JWT của Logto.

## Consequences

**Tích cực:**
- Validate JWT OIDC chuẩn — không cần Logto SDK trong đường dẫn nóng; chỉ cần JWKS + xác minh JWT
- Hỗ trợ tổ chức đa tenant qua tính năng Organizations của Logto
- Mã nguồn mở theo Apache 2.0 — có thể tự host mà không bị khóa vào nhà cung cấp
- Xử lý xoay token an toàn, refresh token và PKCE ngay từ đầu

**Tiêu cực:**
- Thêm một dịch vụ phải triển khai và bảo trì (container Logto ở chế độ Docker)
- Mô hình đa tenant của Logto có thể không ánh xạ hoàn hảo sang cô lập cấp site của LumiBase — đòi hỏi cấu hình Organizations cẩn thận
- Migration từ một nhà cung cấp xác thực khác đòi hỏi phát hành lại toàn bộ token

**Trung tính:**
- `LOGTO_ENDPOINT` và `LOGTO_APP_ID` là các biến môi trường bắt buộc cho cả hai chế độ triển khai
