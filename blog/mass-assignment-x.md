# Vibecode #25 — Mass Assignment (X/Twitter)

---

Đến khách sạn, điền form check-in loại phòng standard rồi lén thêm: loại phòng = Presidential Suite. Nhân viên nhập y nguyên. M vừa tự upgrade miễn phí. Code cũng vậy — đó là Mass Assignment. (1/4)

---

2012 Egor Homakov gửi thêm organization_id vào request, tự gán mình vào rails/rails trên GitHub. Không crack gì cả. Attacker chỉ cần thêm { isAdmin: true } vào body nếu server dùng Object.assign(user, req.body) mà không lọc. (2/4)

---

LumiBase nhận write từ editor, AI skill, webhook, extension. M chặn 3 lớp: Zod strip field lạ ở boundary, service chỉ nhận typed DTO không nhận raw body, siteId và createdBy lấy từ middleware context — không bao giờ từ req.body. (3/4)

---

Whitelist field thay vì blacklist. Thêm column nhạy cảm mới mà không cập nhật blacklist là đủ để toang. Cái giúp dev code nhanh lại là cái mở cửa cho attacker. M build LumiBase — Content OS bảo mật từ nền. Ghé lumibase.dev 🌱 (4/4)
