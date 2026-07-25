# Vibecode #25 — Mass Assignment (Threads)

---

Đến khách sạn, điền form check-in: tên, ngày đến, loại phòng standard. Nhưng m lén thêm một dòng vào form: loại phòng = Presidential Suite. Nhân viên lễ tân nhập y nguyên vào hệ thống. M vừa tự upgrade miễn phí.

Đây là Mass Assignment. Và nó xảy ra với code mỗi ngày. (1/7)

---

Trong nhiều framework, khi nhận request body từ client, dev hay làm kiểu này: User.create(req.body) hoặc Object.assign(user, req.body). Nếu model User có field isAdmin hay role, và attacker gửi thêm { isAdmin: true } vào body thì hệ thống nhận nguyên không lọc. Không cần crack password hay token. (2/7)

---

2012, Egor Homakov khai thác đúng lỗi này trên GitHub. Ông tự gán mình vào tổ chức rails/rails — tức repository của Ruby on Rails chính thức — bằng cách thêm organization_id vào request. GitHub phải lock tài khoản ông. Nhưng đó là lỗi của hệ thống, không phải của ông. (3/7)

---

LumiBase là CMS nhận content từ khắp nơi: dashboard editor, AI skill, webhook, extension. Mọi nơi đều gọi API với JSON body. Nếu service layer dùng spread hay Object.assign để merge request body vào entity thì bất kỳ field nào trong model đều có thể bị ghi đè — kể cả siteId, createdBy, permissions. (4/7)

---

Cách m vá đầu tiên: không bao giờ dùng req.body trực tiếp. Mọi input đều qua Zod schema trước. Zod chỉ parse đúng những field đã khai báo. Bất kỳ field lạ nào — kể cả isAdmin, siteId, role — đều bị strip tự động. Poison không thể vào nếu cổng vào đã lọc kỹ. (5/7)

---

Cách m vá thứ hai: service layer chỉ nhận object đã typed, không nhận raw body. Thay vì User.create(req.body), m có hàm createUser(dto: CreateUserDto) chỉ lấy đúng các field trong DTO ra để insert. Dù attacker gửi gì thêm, service không nhìn thấy. Defense in depth: cả hai lớp cùng bảo vệ. (6/7)

---

Mass Assignment trông hiền nhưng nguy hiểm vì nó khai thác đúng sự tiện lợi của framework. Cái giúp dev code nhanh lại là cái mở cửa cho attacker. Whitelist field thay vì blacklist. Validate schema từ cổng vào, đừng tin req.body. M đang build LumiBase — Content OS cho agent, bảo mật làm nền từ đầu. Ghé lumibase.dev 🌱 (7/7)
