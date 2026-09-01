---
version: 1
lastUpdated: 2026-08-02T19:08:20.200Z
sourceLang: en
translatedFrom: en
sourceHash: b4c3cb49368f85ba
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:08:20.200Z
codeVerifiedHash: b4c3cb49368f85ba
codeVerifiedClaims: 4
---

# Data Residency & Cross-Border Transfers

> Hướng dẫn giữ dữ liệu cá nhân trong khu vực bắt buộc (EU adequacy/SCCs, nội địa
> hoá theo Nghị định 53/2022 của VN) với mô hình triển khai kép edge/Docker của
> LumiBase.
>
> **⚠️ Không phải tư vấn pháp lý.** Quy tắc nội địa hoá và chuyển dữ liệu phụ thuộc
> tình huống và thay đổi thường xuyên. Xác nhận với luật sư. Các chi tiết điều luật
> `[Unverified]` cần đối chiếu văn bản gốc.

## 1. Vì sao quan trọng

| Thị trường | Nghĩa vụ (tóm tắt) |
|------------|--------------------|
| EU (GDPR Ch. V) | Chuyển dữ liệu ra ngoài EEA cần cơ chế hợp pháp — quyết định adequacy, SCCs, hoặc BCRs. |
| Việt Nam (NĐ 53/2022, Luật ANM) | `[Unverified]` Một số nhà cung cấp phải lưu dữ liệu nhất định tại VN và có thể cần pháp nhân/chi nhánh trong nước. Xác minh phạm vi cho dịch vụ của bạn. |
| US (theo ngành) | Không có quy tắc lưu trú chung; yêu cầu hợp đồng/bang có thể áp dụng. |

## 2. LumiBase lưu dữ liệu ở đâu

- **Database** — nguồn sự thật duy nhất cho mọi dữ liệu cá nhân. Khu vực do host
  Postgres (Neon/Supabase/tự host) quyết định. **Đây là điểm kiểm soát lưu trú chính.**
- **Edge cache / runtime** — Cloudflare Workers chạy toàn cầu; response cache có thể
  nhân bản tới các PoP edge. Coi cache là tạm thời và tránh cache response đã xác thực
  chứa PII.
- **Object storage / files** — khu vực bucket R2/S3.
- **Transport email, sink CDC, Firebase sync** — mỗi cái là một lần chuyển dữ liệu xuyên
  biên giới tới khu vực của nhà cung cấp đó.

## 3. Cách ghim khu vực

1. **Database:** tạo instance Postgres trong khu vực bắt buộc; ghim bản chính thức của
   mọi dữ liệu cá nhân.
2. **Triển khai Docker:** chạy container CMS trong khu vực để kiểm soát hoàn toàn — mô
   hình triển khai kép (`apps/cms/src/serve.ts`) hỗ trợ host Node một khu vực, mô hình
   đơn giản nhất cho nội địa hoá nghiêm ngặt.
3. **Triển khai Edge:** giữ database trong khu vực; cấu hình object storage và sink trong
   khu vực; giảm thiểu PII trong trạng thái cache/edge.
4. **Sub-processor:** chọn endpoint SMTP/CDC/Firebase trong khu vực, hoặc tắt các tính
   năng đó nơi không được phép chuyển xuyên biên giới.

## 4. Cơ chế chuyển (EU)

`[Inference]` Với mọi processor ngoài EEA, áp SCCs qua DPA (xem
[dpa-template.md](./dpa-template.md)) và ghi lần chuyển vào ROPA.

## 5. Trạng thái trong LumiBase

- ✅ Cô lập đa tenant (`apps/cms/src/middleware/rls.ts`) tách biệt tenant nhưng tự nó
  **không** ghim khu vực.
- ⚠️ Ghim khu vực là lựa chọn **vận hành/triển khai**, không phải setting ứng dụng hiện
  nay. Chưa có routing khu vực theo bản ghi. `[Inference]` Để lưu trú đa khu vực, chạy
  các triển khai riêng theo từng khu vực.
