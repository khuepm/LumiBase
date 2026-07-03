# Tuân thủ & Quyền của người dùng

> Mục này ánh xạ **các quyền pháp lý mà người dùng cuối được hưởng** theo quy định
> của các thị trường lớn (EU, US, Việt Nam) và **yêu cầu chính sách của các nền tảng
> phân phối ứng dụng** (Google Play, Apple App Store) vào năng lực hiện tại của
> LumiBase.
>
> **⚠️ Đây không phải tư vấn pháp lý.** Tài liệu này là bản tóm tắt thiên về kỹ thuật
> dành cho đội sản phẩm/nền tảng. Quy định thay đổi theo thời gian và cách áp dụng phụ
> thuộc vào luồng dữ liệu, khu vực pháp lý, và vai trò của bạn (bên kiểm soát dữ liệu
> hay bên xử lý). Hãy kiểm chứng mọi nghĩa vụ với luật sư/chuyên gia bảo vệ dữ liệu
> (DPO) trước khi dựa vào. Nội dung không kiểm chứng được nguồn gốc gắn nhãn
> `[Inference]`, `[Speculation]`, hoặc `[Unverified]`.

## 1. Cách dùng mục này

| Tài liệu | Mục đích |
|----------|----------|
| [user-rights-catalog.md](./user-rights-catalog.md) | Giải thích dễ hiểu từng quyền (là gì, ví dụ thực tế, áp dụng ở đâu). **Bắt đầu từ đây.** |
| [market-eu-gdpr.md](./market-eu-gdpr.md) | EU: GDPR + ePrivacy/cookie + chuyển dữ liệu xuyên biên giới. |
| [market-us.md](./market-us.md) | US: CCPA/CPRA + CAN-SPAM + các luật bang khác. |
| [market-vietnam.md](./market-vietnam.md) | Việt Nam: PDPD (Nghị định 13/2023), an ninh mạng & nội địa hoá, giấy phép xuất bản nội dung. |
| [provider-google-apple.md](./provider-google-apple.md) | Chính sách nền tảng: Google Play Data safety + nhãn quyền riêng tư & xoá tài khoản của Apple. |
| [gap-analysis.md](./gap-analysis.md) | Ánh xạ Quyền ↔ tính năng LumiBase, kèm trạng thái (✅/⚠️/❌) và bằng chứng file. |
| [data-map.md](./data-map.md) | Kiểm kê nơi dữ liệu cá nhân tồn tại, làm cơ sở cho thông báo riêng tư và nhãn store. |
| [data-residency.md](./data-residency.md) | Hướng dẫn ghim khu vực & chuyển dữ liệu xuyên biên giới (EU SCCs, VN NĐ 53). |
| [dpa-template.md](./dpa-template.md) | Khung Thoả thuận xử lý dữ liệu (GDPR Điều 28) cho dịch vụ hosted. |
| [implementation-checklist.md](./implementation-checklist.md) | Backlog ưu tiên (P0/P1/P2) để lấp khoảng trống. |

Bản tiếng Anh nằm ở `docs/en/compliance/`.

## 2. Ma trận Quyền × Thị trường

Bảng định hướng nhanh. ✔ = được công nhận **rõ ràng**; `~` = bao phủ **một phần/gián
tiếp**; để trống = không phải yêu cầu luật định trực tiếp ở chế độ đó. Xem từng tài
liệu thị trường để biết phạm vi, ngoại lệ và ngưỡng áp dụng chính xác.

| Quyền / nghĩa vụ | EU (GDPR) | US (CCPA/CPRA) | VN (PDPD) | Google Play | Apple App Store |
|------------------|:---------:|:--------------:|:---------:|:-----------:|:---------------:|
| Quyền được lãng quên / xoá dữ liệu | ✔ (Đ.17) | ✔ (delete) | ✔ | ✔ (xoá dữ liệu) | ✔ (5.1.1(v)) |
| Quyền truy cập / được biết | ✔ (Đ.15) | ✔ (right to know) | ✔ | `~` | `~` |
| Di chuyển dữ liệu (portability) | ✔ (Đ.20) | `~` (CPRA) | `~` | | |
| Chỉnh sửa (rectification) | ✔ (Đ.16) | ✔ (correct) | ✔ | | |
| Hạn chế xử lý | ✔ (Đ.18) | `~` | `~` | | |
| Phản đối / từ chối (opt-out) | ✔ (Đ.21) | ✔ (opt-out bán/chia sẻ) | `~` | | `~` (ATT) |
| Đồng ý + rút lại đồng ý | ✔ (Đ.6/7) | `~` | ✔ | `~` | `~` |
| Đồng ý cookie / theo dõi | ✔ (ePrivacy) | `~` | `~` | | ✔ (ATT) |
| Huỷ đăng ký email | `~` (ePrivacy) | ✔ (CAN-SPAM) | `~` | | |
| Xoá tài khoản (in-app + web) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Minh bạch / thông báo quyền riêng tư | ✔ (Đ.12–14) | ✔ | ✔ | ✔ (Data safety) | ✔ (Privacy labels) |
| Thông báo vi phạm dữ liệu | ✔ (Đ.33–34) | `~` | ✔ | | |
| Kiểm soát chuyển dữ liệu xuyên biên giới | ✔ (Ch. V / SCCs) | | ✔ (nội địa hoá) | | |

> `[Inference]` Giá trị trong ô là công cụ định hướng đơn giản hoá, suy ra từ phần
> phân tích từng thị trường; không thay thế văn bản luật. Coi `~` là "cần kiểm chứng
> điều kiện kích hoạt và ngoại lệ với luật sư".

## 3. Mức độ sẵn sàng của LumiBase (tóm tắt)

| Năng lực | Trạng thái | Bằng chứng |
|----------|:----------:|------------|
| Audit log + provenance | ✅ | `apps/cms/src/modules/audit/` |
| Retention audit (tự động dọn) | ✅ | `apps/cms/src/modules/audit/rotator.ts` |
| Cô lập đa tenant (RLS) | ✅ | `apps/cms/src/middleware/rls.ts` |
| Mã hoá field-level (AES-256-GCM) | ✅ | `apps/cms/src/services/crypto-service.ts` |
| RBAC / phân quyền chi tiết | ✅ | `packages/database/src/schema/access.ts` |
| Soft-delete content item | ✅ | `packages/database/src/schema/cms.ts` (`items.deletedAt`) |
| Xoá tài khoản toàn cục (quyền được lãng quên) | ❌ | — (xem gap-analysis) |
| Xuất dữ liệu cá nhân ("download my data") | ❌ | — |
| Quản lý đồng ý & rút lại đồng ý | ❌ | — |
| Trung tâm đăng ký / huỷ đăng ký email | ❌ | — |
| Chính sách retention tổng quát | ❌ | — |

Xem [gap-analysis.md](./gap-analysis.md) cho ánh xạ đầy đủ và
[implementation-checklist.md](./implementation-checklist.md) cho backlog.

## 4. Thuật ngữ chính

- **Chủ thể dữ liệu / người dùng** — cá nhân mà dữ liệu cá nhân nói về họ.
- **Bên kiểm soát (controller)** — quyết định mục đích và cách xử lý dữ liệu. Đơn vị
  tự vận hành LumiBase (khách hàng tự host) thường là bên kiểm soát.
- **Bên xử lý (processor)** — xử lý dữ liệu thay cho bên kiểm soát. `[Inference]` Với
  bản LumiBase được host/quản lý, bên host có thể là processor; với self-host thuần
  có thể không có processor riêng. Xác nhận vai trò với luật sư.
- **PII / dữ liệu cá nhân** — mọi thông tin liên quan đến một người đã/có thể xác định.
- **DSR / DSAR** — Yêu cầu của chủ thể dữ liệu: người dùng thực hiện một trong các
  quyền trên.
