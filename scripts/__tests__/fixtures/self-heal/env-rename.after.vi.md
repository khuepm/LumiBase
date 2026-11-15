# Gizmo

Dịch vụ gizmo nằm trong `apps/cms/src/services/gizmo-service.ts` và một gizmo
mới được tạo bằng `createGizmo()`. Mỗi gizmo thuộc về đúng một site.

Đặt `LUMIBASE_GIZMO_MAX` để giới hạn số lượng gizmo mà một site được phép lưu
giữ. Khi đã chạm giới hạn, dịch vụ sẽ từ chối thao tác ghi với một lỗi kiểm tra
dữ liệu.

## API

Lấy một gizmo bằng `GET /api/v1/gizmos/:id`. Phản hồi tuân theo cấu trúc bao
gói thông thường của hệ thống.

```bash
export LUMIBASE_GIZMO_MAX=10
curl https://cms.example.com/api/v1/gizmos/$GIZMO_ID
```
