---
version: 1
lastUpdated: 2026-07-05T10:56:37.062Z
sourceLang: en
translatedFrom: en
sourceHash: 10c992809cf09694
mtEngine: claude
syncStatus: machine-translated
---

# ADR-003: Human-in-the-Loop (HITL) cho các AI Skill nguy hiểm

**Date:** 2024-03-20
**Status:** Accepted

## Context

LumiBase bao gồm một AI Copilot (`apps/cms/src/services/ai-harness.ts`) cho phép người dùng admin đưa ra các lệnh bằng ngôn ngữ tự nhiên, được thực thi dưới dạng các "skill" đã định kiểu (ví dụ `createCollection`, `deleteItem`, `updateField`).

Nếu không có rào chắn, một AI agent có thể:
- Hiểu sai một lệnh mơ hồ và xóa một collection production
- Bị thao túng qua prompt injection trong nội dung do người dùng cung cấp
- Thực thi một migration schema không dễ đảo ngược
- Xâu chuỗi nhiều thao tác phá hủy trước khi con người nhận ra

Hồ sơ rủi ro là bất đối xứng: đọc dữ liệu là rủi ro thấp, nhưng thay đổi schema và xóa hàng loạt là tiềm tàng thảm họa và không thể đảo ngược.

## Decision

Phân loại mọi AI skill vào một trong hai nhóm:

**Skill an toàn** (thực thi ngay lập tức):
- Bất kỳ skill nào chỉ *đọc* dữ liệu: `listCollections`, `listItems`
- Thao tác tạo/cập nhật trên *items* (dữ liệu, không phải schema): `createItem`, `updateItem`

**Skill nguy hiểm** (đòi hỏi phê duyệt Human-in-the-Loop):
- Bất kỳ skill nào đòi hỏi capability `schema:write`: `createCollection`, `deleteCollection`, `createField`, `deleteField`, `updateField`
- Bất kỳ skill nào có tên bắt đầu bằng `delete`: `deleteItem`, `deleteCollection`, `deleteField`, `deleteUser`

Logic phân loại trong `AISecureHarness.evaluateRisk()`:

```typescript
function isDangerous(skill: Skill, session: Session): boolean {
  return skill.requiredCapabilities.includes('schema:write') ||
         skill.name.startsWith('delete');
}
```

Khi một skill nguy hiểm được yêu cầu:
1. Harness tạo một hàng `ai_approvals` với `status='pending'`, lưu tên skill và các tham số
2. Nó trả về `{ status: 'pending_approval', approvalId }` cho Studio UI
3. Một admin xem lại phê duyệt trong Approvals Dashboard và bấm **Approve** hoặc **Reject**
4. Khi được phê duyệt, harness thực thi skill với các tham số đã lưu

## Consequences

**Tích cực:**
- Con người vẫn kiểm soát mọi thao tác phá hủy hoặc thay đổi schema
- Dấu vết audit: mọi hành động AI (được thực thi hay bị từ chối) đều được ghi vào `ai_approvals`
- Giảm bán kính ảnh hưởng của tấn công prompt injection — một chỉ thị bị chèn cùng lắm chỉ tạo được một phê duyệt đang chờ, mà con người phải xem lại
- Quy tắc đơn giản, dễ đoán mà lập trình viên và admin có thể hiểu ngay lập tức

**Tiêu cực:**
- Thêm ma sát cho các lệnh phá hủy hợp lệ — admin phải chuyển ngữ cảnh sang Approvals Dashboard
- Luồng bất đồng bộ làm phức tạp UX của Studio (cần badge đang chờ, polling hoặc WebSocket push)
- Ký tự đại diện `'*'` trong capability của người dùng bỏ qua phân loại — phải giới hạn chỉ cho superadmin

**Trung tính:**
- Ngưỡng (an toàn so với nguy hiểm) là một quyết định mang tính phán đoán. Vòng lặp tương lai có thể thêm một nhóm trung gian ("cảnh báo nhưng vẫn thực thi") cho các thao tác rủi ro trung bình
- HITL không ngăn được một tài khoản superadmin bị xâm phạm phê duyệt các hành động bị chèn — đây là một hạn chế đã biết nằm ngoài phạm vi của AI harness
