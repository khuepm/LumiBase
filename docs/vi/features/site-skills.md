---
version: 1
lastUpdated: 2026-11-11T01:20:48.242Z
sourceLang: en
translatedFrom: en
sourceHash: ea10e3ae2fb9950c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-11T01:20:48.242Z
codeVerifiedHash: ea10e3ae2fb9950c
codeVerifiedClaims: 24
---

# Site Skills

**Site skill** là một playbook mà đội của bạn viết ra cho các agent: văn phong
của site, quy tắc dịch, cấu trúc một trang sản phẩm, điều một tiêu đề không bao
giờ được nói. Đó là Markdown kèm một khối front matter nhỏ, lưu theo từng site,
có phiên bản, và được thêm vào chỉ dẫn của mọi agent run mà nó áp dụng.

> **Về tên gọi.** "Skill" cũng là tên các tool gọi được của harness
> (`listItems`, `aiContentAssist`, … — xem [AI skills](../ai-skills.md)). Những
> thứ đó là code và nằm trong `lumibase_agent_tools`. Một *site* skill là văn
> xuôi và nằm trong `lumibase_site_skills`. Site skill không bao giờ thêm tool.

## Site skill làm được gì và không làm được gì

| Nó làm | Nó không làm |
|---|---|
| Thêm văn bản chỉ dẫn vào các run khớp | Cấp capability hay tool |
| Định hình giọng văn, cấu trúc và quy trình | Đổi định dạng output mà một tool yêu cầu |
| Để lại dấu `slug@version` + hash trên thứ nó đã định hình | Vượt qua HITL, mức autonomy, kill switch hay publish gate của constitution |

Governance được quyết định y hệt như khi không có skill. Điều tệ nhất một skill
viết dở có thể gây ra là khiến model viết dở — đó là lý do việc soạn skill vẫn
là một hành vi được quản trị (xem [Governance](#governance)).

## Định dạng tài liệu

```markdown
---
slug: house-style
name: House style
description: Voice and formatting rules for editorial copy
riskClass: low
priority: 10
surfaces: [copilot, generation]
tools: [aiContentAssist]
collections: [posts]
triggers: [headline, intro]
requiredCapabilities: [items:write]
---

# House style

Write in active voice. Sentences under 25 words.
Never use "utilize"; say "use".
```

| Key | Ý nghĩa | Mặc định |
|---|---|---|
| `slug` | Định danh, duy nhất trong một site. Chữ thường, chữ số, gạch nối đơn; tối đa 64 ký tự. Không đổi được. `import`, `export` và `match` là tên dành riêng. | tên file |
| `name` | Tên hiển thị, tối đa 120 ký tự. | `# heading` đầu tiên |
| `description` | Một dòng, tối đa 500 ký tự. Hiện trong danh sách và làm mô tả prompt MCP. | rỗng |
| `riskClass` | `low`, `medium` hoặc `high`. `high` chỉ dành cho admin. | `low` |
| `priority` | Từ `-100` đến `100`. Số lớn hơn được chèn trước khi ngân sách chật. | `0` |
| `surfaces` | `copilot`, `generation`, `mcp`. Rỗng nghĩa là tất cả. | tất cả |
| `tools` | Tên các tool harness mà skill bị giới hạn vào. Rỗng nghĩa là bất kỳ. | bất kỳ |
| `collections` | Tên các collection mà skill bị giới hạn vào. Rỗng nghĩa là bất kỳ. | bất kỳ |
| `triggers` | Từ khoá so khớp không phân biệt hoa thường với văn bản yêu cầu. Rỗng nghĩa là "luôn luôn, trong phạm vi". | luôn luôn |
| `requiredCapabilities` | Các capability người gọi phải có thì skill mới được đưa ra. | không có |

Front matter là một tập con YAML cố ý giữ nhỏ: `key: value`, `key: [a, b]`, và
`key:` theo sau là các dòng `- item`. Key lạ là lỗi chứ không bị bỏ qua — một
lỗi gõ ở `triggers` không được âm thầm biến một skill hẹp thành skill áp dụng ở
mọi nơi. Phần thân dài từ 1 đến 20.000 ký tự.

## Skill được chèn ở đâu

Chỉ skill `active` mới được chèn. Một site không có skill active nào gửi đúng
những request nó đã gửi trước khi tính năng này tồn tại.

| Surface | Ở đâu | Ngữ cảnh so khớp |
|---|---|---|
| `copilot` | `POST /api/v1/ai/chat`, đồng bộ và `Prefer: respond-async` | tin nhắn của người dùng; capability của người gọi |
| `generation` | các tool harness có gọi model: `aiContentAssist`, `aiSuggestField`, `repairTranslation`, `generateAppSpec`, `generateSeedData` | tên tool, collection của nó, chỉ dẫn của nó |
| `mcp` | `prompts/list` và `prompts/get` trên `POST /api/v1/mcp` | capability của người gọi (client tự chọn nên trigger không lọc) |

Quy tắc so khớp:

- **Phạm vi là phép VÀ.** Surface, tool, collection, capability và trigger đều
  phải đạt.
- **Collection.** Khi run nêu tên một collection thì collection đó phải nằm
  trong danh sách. Khi không nêu (một tin nhắn chat), skill chỉ áp dụng nếu văn
  bản nhắc tới một collection trong danh sách. Không biết không bao giờ có
  nghĩa là "áp dụng".
- **Capability fail closed.** Bên trong một generation tool, capability của
  người gọi không được biết, nên skill có `requiredCapabilities` bị giữ lại ở
  đó. Nó vẫn áp dụng trong Copilot và qua MCP.
- **Grounded generation được miễn.** `aiContentAssist` với `grounded: true`
  trích nguyên văn từ bằng chứng; không playbook nào được thêm vào lời gọi đó.

### Ngân sách

Tối đa 6 skill và 12.000 ký tự thân được chèn vào một run, xếp theo `priority`
(giảm dần) rồi `slug`. Skill không vừa bị bỏ qua nguyên cả skill — một playbook
bị cắt cụt tệ hơn một playbook vắng mặt — và các skill nhỏ hơn phía sau vẫn có
thể vừa. `POST /api/v1/agent/skills/match` cho thấy một run cụ thể sẽ nhận gì,
kể cả những gì bị bỏ qua.

### Provenance

Mỗi lần chèn được ghi lại dưới dạng `{ slug, version, hash }`:

- generation tool trả nó về ở `meta.siteSkills`, và vết agent run lưu nó cùng
  tool call;
- Copilot lưu nó trong metadata của tin nhắn assistant và trả về dưới tên
  `siteSkills` trong response chat;
- `prompts/get` trả nó về dưới `_meta["lumibase/siteSkill"]`.

Sửa skill về sau không viết lại lịch sử: dòng phiên bản mà một run được đóng
dấu là bất biến.

## Phiên bản

Mỗi thay đổi nội dung thêm một dòng vào `lumibase_site_skill_versions` với
snapshot đầy đủ, hash sha256 của nó, tác giả (user id, hoặc `api_key:<id>`),
nguồn (`studio`, `api`, `cli`, `package`), tham chiếu nguồn tuỳ chọn và ghi chú
thay đổi. Một lần ghi không đổi nội dung (cùng hash) không tạo phiên bản. Khôi
phục phiên bản *N* ghi nội dung của nó thành một phiên bản **mới**, nên vết chỉ
dài thêm.

Status (`draft` → `active` → `archived`) không thuộc về phiên bản: nó cho biết
phiên bản hiện tại có đang chạy hay không. Việc kích hoạt, lưu trữ, sửa và xoá
được ghi vào activity log dưới các mục `site_skill.*`.

> Sửa một skill `active` thay đổi hành vi agent ngay lập tức. Để dàn dựng một
> thay đổi, đưa skill về `draft` trước, hoặc push từ một branch và kích hoạt
> khi merge.

## Governance

- Toàn bộ bề mặt nằm dưới `/api/v1/agent`, nơi control-plane guard giới hạn cho
  principal admin.
- Thao tác ghi cần thêm capability `skills:write` hoặc control-plane admin.
  Thao tác đọc thì không.
- `riskClass: high` chỉ dành cho admin theo mọi chiều: tạo, sửa, hạ mức, kích
  hoạt, lưu trữ và xoá. Dùng nó cho các playbook điều hướng hành vi hệ trọng
  (nội dung giá, câu chữ pháp lý, bất cứ thứ gì một agent mức autopilot sẽ hành
  động mà không qua duyệt).
- Skill mới luôn được tạo ở `draft`. Skill được import giữ `draft` trừ khi lệnh
  import nói `activate`.
- Skill là chỉ dẫn được tin vì người được phép viết nó. Content, tài liệu truy
  xuất và tin nhắn chat không bao giờ trở thành skill nếu thiếu capability đó,
  và chúng tiếp tục đi vào prompt dưới dạng dữ liệu không tin cậy.

## API

Mọi route nằm dưới `/api/v1/agent/skills`. `:id` nhận id hoặc slug.

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/` | Liệt kê skill. Tuỳ chọn `?status=draft\|active\|archived`. |
| `POST` | `/` | Tạo một draft. Body: các field front matter cộng `body`; tuỳ chọn `source`, `sourceRef`, `changeNote`. `201`; `409 CONFLICT` khi trùng slug. |
| `GET` | `/:id` | Một skill, kèm `document` (dạng Markdown). |
| `PATCH` | `/:id` | Cập nhật một phần; field bị bỏ qua được giữ nguyên. `meta.changed` là `false` khi không có gì đổi. `slug` không đổi được. |
| `DELETE` | `/:id` | Xoá skill và vết phiên bản của nó. Có audit. |
| `POST` | `/:id/activate` · `/:id/archive` · `/:id/draft` | Đổi status. |
| `GET` | `/:id/versions` | Vết phiên bản, mới nhất trước. |
| `POST` | `/:id/versions/:version/restore` | Ghi nội dung của một phiên bản cũ thành phiên bản mới. |
| `POST` | `/import` | Upsert tài liệu Markdown theo slug. Body `{ documents: [{ path?, content }], activate?, dryRun?, source?, sourceRef? }`, 1–100 tài liệu. Trả một kết quả cho mỗi tài liệu (`created`, `updated`, `unchanged`, `error`) và số đếm trong `meta`. Một tài liệu hỏng không huỷ phần còn lại. |
| `GET` | `/export` | Mọi skill dưới dạng `{ slug, filename, status, version, hash, content }`. Import lại một bản export là no-op. |
| `POST` | `/match` | Xem trước. Body `{ surface, tool?, collection?, text? }`; trả `{ skills, skipped, prompt }` được đánh giá bằng capability của người gọi. |

Lỗi dùng envelope chuẩn: `VALIDATION` (400), `INVALID_DOCUMENT` (theo từng tài
liệu, trong kết quả import), `FORBIDDEN` và `RISK_REQUIRES_ADMIN` (403),
`NOT_FOUND` (404), `CONFLICT` (409).

## Skills as code

Giữ playbook trong git cạnh content model và để CI triển khai chúng:

```bash
lumibase skills pull                 # write skills/<slug>.skill.md from the site
lumibase skills push --dry-run       # show what would change
lumibase skills push --check         # CI gate: exit 1 if the site differs from git
lumibase skills push --activate      # deploy and activate
lumibase skills install @acme/lumibase-skills   # import a package's skills as drafts
```

`push` và `install` là idempotent: một tài liệu có hash khớp với phiên bản đang
lưu được báo `unchanged` và không ghi gì. `install` đọc skill từ một package đã
cài cục bộ (`package.json` → `lumibase.skills`, mặc định `skills/`) hoặc từ một
đường dẫn; nó không tải gì về. Skill được cài tới ở dạng draft để con người rà
soát trong Studio. Token cần quyền admin trên site và được đọc từ
`LUMIBASE_TOKEN`, không bao giờ từ file config. Xem [CLI](../cli/index.md).

## Studio

**Mission Control → Skills** liệt kê skill cùng status, risk class và phạm vi;
sửa front matter và thân Markdown; kích hoạt, lưu trữ và xoá; hiện vết phiên
bản kèm khôi phục; và có panel **Test match** gọi `/match` để bạn thấy một yêu
cầu mẫu sẽ nhận những skill nào.

## MCP

Khi bật flag `contentOs.mcp`, endpoint MCP quảng bá capability `prompts`.
`prompts/list` trả các skill active được đưa ra cho người gọi (`name` là slug);
`prompts/get` trả phần thân dưới dạng một user message duy nhất. Một prompt
người gọi không được thấy và một prompt không tồn tại trả lời giống hệt nhau.
Các lời gọi organization-plane (`org:*`) không đưa ra prompt.

## Multi-tenancy

| Tài nguyên | Phạm vi |
|---|---|
| `lumibase_site_skills`, `lumibase_site_skill_versions` | Cô lập theo site: `site_id` trên cả hai, mọi query đều lọc theo nó, và cả hai nằm trong danh sách RLS `site_isolation` của `packages/database/migrations/rls-policies.sql`. |
| Slug | Duy nhất trong một site; hai site có thể dùng cùng slug độc lập. |
| Việc chèn | Resolve theo từng run từ site id của chính run đó — site của request với Copilot và MCP, `siteId` của job với việc trong queue. |
| Ngân sách prompt, văn bản mở đầu | Hằng số dùng chung trong code; không có dữ liệu tenant. |

Được kiểm chứng bởi `apps/cms/src/services/__tests__/site-skills.db.integration.test.ts`
("tenant isolation"): site B không thể liệt kê, đọc, match, sửa, export hay xoá
skill của site A, và một generation run trên site B không nhận skill nào trong
số đó.

## Nâng cấp

Migration `0026_site_skills` tạo hai bảng và không sửa gì có sẵn; không cần
backfill. Áp lại `rls-policies.sql` sau đó, như sau mọi lần nâng cấp. Nếu code
được deploy trước khi migration chạy, agent run tiếp tục mà không có playbook
và ghi một cảnh báo; chúng không fail.
