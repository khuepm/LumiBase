---
title: Tutorials
version: 1
lastUpdated: 2026-08-02T19:07:54.568Z
sourceLang: en
translatedFrom: en
sourceHash: ec70515719fa4318
mtEngine: manual
syncStatus: human-translated
---

# Tutorials

Các hướng dẫn end-to-end, đưa bạn từ con số 0 đến một kết quả chạy được. Mỗi tutorial không
giả định kiến thức LumiBase trước đó và liệt kê điều kiện cần ngay từ đầu.

<table>
<thead>
<tr><th>Tutorial</th><th>Bạn sẽ xây dựng</th><th>Version tối thiểu</th><th>Cấp độ</th></tr>
</thead>
<tbody>
<tr>
  <td><a href="./nextjs-quickstart.md">Hiển thị nội dung LumiBase trên app Next.js</a></td>
  <td>Một trang Next.js fetch collection <code>posts</code> và render ra</td>
  <td><img alt="0.9.0" src="https://img.shields.io/badge/%E2%89%A5%200.9.0-F5A623"></td>
  <td>Cơ bản</td>
</tr>
</tbody>
</table>

## Cơ chế version của tutorial

> [!NOTE]
> Tutorial được **pin theo phiên bản LumiBase tối thiểu**, không clone lại theo từng release.

- Badge **Version tối thiểu** là phiên bản LumiBase thấp nhất mà tutorial còn đúng.
- Tutorial vẫn đúng cho mọi bản mới hơn **cho tới khi** một API contract nó phụ thuộc thay
  đổi. Nên một tutorial viết cho `0.9.0` vẫn chạy trên `0.10`, `0.15`, … mà không cần sửa,
  miễn là các contract đó còn giữ nguyên.
- Mỗi tutorial kết thúc bằng mục **Tương thích** liệt kê bảng version (**mới nhất ở trên
  cùng**) và đúng các contract nó dựa vào. Đối chiếu phiên bản LumiBase của bạn với dòng
  trên cùng phù hợp.
- Khi một release phá vỡ contract, ta bump bảng của riêng tutorial đó và verify lại — được
  ép buộc bởi [Definition of Done](../../../.kiro/steering/definition-of-done.md) §5
  (Tutorial impact). Ta **không** tạo bản sao mới theo từng version.

> Muốn khởi tạo dự án LumiBase mới từ đầu? Xem [Getting Started](../getting-started.md).
> Muốn chạy toàn bộ monorepo ở local? Xem
> [Local Development](../deployment/local-development.md).
