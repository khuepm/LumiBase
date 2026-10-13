# 🔎 Reviewer — Sửa persistence của ngoại lệ parity trong PR #456

PR: https://github.com/khuepm/LumiBase/pull/456 · Issue #453, epic #331.
Base đã kiểm tra: 9e6f3e9bca09ecea8397661c47b243d5c4dd7d84.
Owner giao trực tiếp sửa công cụ docs-i18n trong PR này ngày 2026-09-11.

`stamp-pair --allow-structure-drift` trước đây bỏ qua lỗi nhưng không lưu ngoại lệ,
nên lần chạy parity sau tiếp tục chặn cùng tài liệu. Nay CLI ghi waiver tương thích
với checker hiện có vào body tài liệu đích, chỉ cho các loại lỗi thực sự được bỏ
qua; kèm timestamp và tên lệnh. Lý do nghiệp vụ được ghi trong commit message theo
quy ước hiện có. Waiver áp dụng theo loại kiểm tra, không phải từng occurrence.

Ghi waiver sau verification: một lần từ chối không sửa file. Stamp lại không tạo
waiver trùng; các loại lỗi chưa được miễn vẫn chặn. Hướng dẫn EN/VI được cập nhật
và stamp đồng bộ. Waiver thủ công có sẵn của PR được giữ lại.

Xác minh trực tiếp: scripts:test 33/33 đạt; test CLI cách ly kiểm tra persistence,
idempotency, lỗi mới và refusal không ghi file; diff-check sạch. Kết luận chỉ áp
dụng bản sửa tooling này, không phải chấp thuận merge toàn bộ PR #456.
