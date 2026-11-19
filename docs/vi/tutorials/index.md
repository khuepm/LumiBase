---
title: Tutorials
version: 3
lastUpdated: 2026-11-19T09:00:27.639Z
sourceLang: en
translatedFrom: en
sourceHash: 739848d92528082c
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
<tr>
  <td><a href="./astro-starter.md">Astro starter — site tĩnh trên Cloudflare Pages</a></td>
  <td>Một blog tĩnh được build từ collection <code>posts</code> lúc build, deploy bằng <code>wrangler pages deploy</code></td>
  <td><img alt="2.0.0" src="https://img.shields.io/badge/%E2%89%A5%202.0.0-F5A623"></td>
  <td>Cơ bản</td>
</tr>
<tr>
  <td><a href="./sveltekit-starter.md">SvelteKit starter — load phía server và draft preview</a></td>
  <td>Một site Cloudflare Pages đọc nội dung theo từng request, có draft preview bằng cookie có chữ ký</td>
  <td><img alt="2.0.0" src="https://img.shields.io/badge/%E2%89%A5%202.0.0-F5A623"></td>
  <td>Trung cấp</td>
</tr>
<tr>
  <td><a href="./backend-template-blog.md">Tạo backend blog từ một template</a></td>
  <td>Collection, relation và nội dung demo tuỳ chọn từ <code>wordpress-alike</code>, qua REST, MCP hoặc Studio</td>
  <td><img alt="unreleased" src="https://img.shields.io/badge/unreleased-9E9E9E"></td>
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
