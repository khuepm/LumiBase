---
version: 1
lastUpdated: 2026-08-02T19:02:55.280Z
sourceLang: en
translatedFrom: en
sourceHash: 0bbce68a2aca2873
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:02:55.280Z
codeVerifiedHash: 0bbce68a2aca2873
codeVerifiedClaims: 2
---

# ADR-012: Loại bỏ CDC CacheInvalidator

<!-- verify-code-refs: planned apps/cms/src/modules/cdc/cache-invalidator.ts -->

**Ngày:** 2026-08-02  
**Trạng thái:** Được chấp nhận (Accepted)

## Bối cảnh

Mô tả kỹ thuật ClickHouse CDC đã giới thiệu `CacheInvalidator` (`apps/cms/src/modules/cdc/cache-invalidator.ts`) để phản chiếu các thay đổi dòng của Postgres vào Redis (`config:${table}:${recordId}`). Nó chưa từng được đấu nối vào pipeline CDC trên production.

Các vấn đề nếu bật như hiện tại:

1. **Bất đồng bộ namespace của Key** — Các luồng đọc của CMS sử dụng key dựa trên tag (`schema:`, `perm:`, `deliver:`, v.v.), không phải `config:${table}:${recordId}`.
2. **Vi phạm Multi-tenancy (DoD 2b)** — Các key bỏ sót `siteId`, do đó việc bật mô-đun có thể gây hủy cache chéo giữa các tenant.
3. **Luồng ghi đã bị thay thế** — Các thao tác thay đổi item/schema qua API hiện hủy cache qua `CacheProvider.invalidateByTag` ngay tại thời điểm commit (yêu cầu Req 8 của high-load-cache-readiness).

## Quyết định

**Loại bỏ** `CacheInvalidator` và các property test đi kèm. Không đấu nối các sự kiện dòng của CDC vào các cache key của ứng dụng.

Luồng phân phối change-feed của CDC (webhooks, extensions) vẫn được giữ nguyên; chỉ có lớp phản chiếu Redis không sử dụng là bị xóa.

## Hệ quả

### Tích cực

- Không còn dead code gợi ý một luồng hủy cache thứ hai gây xung đột.
- Loại bỏ thiết kế key thiếu siteId trước khi nó kịp ship ra ngoài.
- Đội ngũ vận hành dựa vào một mô hình hủy cache duy nhất đã được lập tài liệu (tag purge + HTTP cache TTL).

### Tiêu cực

- Các thao tác ghi trực tiếp vào cơ sở dữ liệu bỏ qua CMS API sẽ không tự động hủy cache ứng dụng cho đến khi có cơ chế khác purge tag hoặc hết hạn TTL.

## Điều kiện xem xét lại (Reopen conditions)

Chỉ giới thiệu lại một bộ hủy cache dựa trên CDC nếu **tất cả** các điều sau là đúng:

1. Một connector được hỗ trợ phân phối các sự kiện dòng từ bên ngoài luồng ghi của API trên production.
2. Các key được khởi tạo dạng `…:${siteId}:…` và khớp với các đọc giả `CacheProvider` thực tế.
3. Các contract test bao phủ cô lập giữa hai site và căn chỉnh tag-namespace.

Cho đến lúc đó, ưu tiên dùng tính năng purge vận hành (`POST /api/v1/utils/cache/purge`) hoặc sửa các luồng ghi để đi qua API.

## Tài liệu tham khảo

- Thiết kế high-load-cache-readiness §4.5, §21.1 (phương pháp B)
- ADR-004 tag-based cache invalidation
