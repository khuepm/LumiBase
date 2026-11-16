---
version: 2
lastUpdated: 2026-11-12T18:43:32.411Z
sourceLang: en
translatedFrom: en
sourceHash: ef3117c0b3b07b7c
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-12T18:43:32.411Z
codeVerifiedHash: ef3117c0b3b07b7c
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
| `riskClass` | `low`, `medium` hoặc `high`. Một nhãn ưu tiên rà soát, hiện trong Studio. Nó không thay đổi ai được sửa hay kích hoạt skill. | `low` |
| `priority` | Từ `-100` đến `100`. Số lớn hơn được chèn trước khi ngân sách chật. | `0` |
| `surfaces` | `copilot`, `generation`, `mcp`. Rỗng nghĩa là tất cả. | tất cả |
| `tools` | Tên các tool harness mà skill bị giới hạn vào. Rỗng nghĩa là bất kỳ. | bất kỳ |
| `collections` | Tên các collection mà skill bị giới hạn vào. Rỗng nghĩa là bất kỳ. | bất kỳ |
| `triggers` | Từ khoá so khớp không phân biệt hoa thường với văn bản yêu cầu. Rỗng nghĩa là "luôn luôn, trong phạm vi". | luôn luôn |
| `requiredCapabilities` | Các capability người gọi phải có thì skill mới được đưa ra. | không có |

Front matter là một tập con YAML cố ý giữ nhỏ: `key: value`, `key: [a, b]`, và
`key:` theo sau là các dòng `- item`. Key lạ là lỗi chứ không bị bỏ qua — một
lỗi gõ ở `triggers` không được âm thầm biến một skill hẹp thành skill áp dụng ở
mọi nơi. Phần thân dài từ 1 đến 12.000 ký tự — bằng [ngân sách](#ngân-sách) của
một run, nên một skill đơn lẻ luôn chèn được. Dòng trống ở đầu và khoảng trắng ở
cuối bị bỏ trên mọi đường (Studio, JSON API, import), nên một phần thân chỉ khác
ở đó là cùng một nội dung và có cùng hash.

## Skill được chèn ở đâu

Chỉ skill `active` mới được chèn. Một site không có skill active nào gửi đúng
những request nó đã gửi trước khi tính năng này tồn tại.

| Surface | Ở đâu | Ngữ cảnh so khớp |
|---|---|---|
| `copilot` | `POST /api/v1/ai/chat`, đồng bộ và `Prefer: respond-async` | 3 lượt user mới nhất của cửa sổ hội thoại gửi cho model, cộng tin nhắn hiện tại; capability của người gọi |
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

Tác giả do server ghi lại từ principal đã xác thực và là câu trả lời có thẩm
quyền cho "ai". `source` và `sourceRef` là nhãn do client tự khai (CLI gửi `cli`
hoặc `package`, Studio gửi `studio`); chúng là ngữ cảnh hữu ích, không phải bằng
chứng về nguồn gốc.

Mỗi lần ghi — dòng skill, dòng phiên bản và mục activity của nó — là một
transaction cơ sở dữ liệu: nếu bất kỳ câu lệnh nào lỗi thì không phần nào được
giữ lại, và lần ghi tiếp theo đi tiếp từ phiên bản đã commit gần nhất.

Status (`draft` → `active` → `archived`) không thuộc về phiên bản: nó cho biết
phiên bản hiện tại có đang chạy hay không. Việc kích hoạt, lưu trữ, sửa và xoá
được ghi vào activity log dưới các mục `site_skill.*`, mỗi mục có id
(`skillId`) và slug của skill.

Một skill đã từng được kích hoạt thì không xoá được (`409
SKILL_HAS_BEEN_ACTIVE`): các run có thể đã được đóng dấu bằng phiên bản của nó,
và xoá skill sẽ xoá luôn vết đó. Hãy lưu trữ (archive) nó. Một draft chưa từng
active thì xoá được, cùng với các phiên bản của nó.

> Sửa một skill `active` thay đổi hành vi agent ngay lập tức. Để dàn dựng một
> thay đổi, đưa skill về `draft` trước, hoặc push từ một branch và kích hoạt
> khi merge.

### Sửa đồng thời

`PATCH` nhận `expectedVersion` tuỳ chọn và các thao tác status (`activate`,
`archive`, `draft`) nhận `version` tuỳ chọn. Khi có giá trị mà skill đã sang
phiên bản khác, lần ghi bị từ chối với `409 VERSION_MISMATCH` và lỗi kèm
`currentVersion`. Studio gửi cả hai: phiên bản editor đã tải, và phiên bản đang
hiện trên màn hình khi bạn bấm **Activate** — nên bạn không bao giờ kích hoạt
nội dung mình chưa thấy.

## Governance

- Toàn bộ bề mặt nằm dưới `/api/v1/agent`, nơi control-plane guard giới hạn cho
  principal admin. Đọc skill cũng cần đúng điều đó: các method MCP `prompts/*`
  tự áp quy tắc này (xem [MCP](#mcp)).
- **Mọi thao tác ghi cần control-plane admin** — tạo, sửa, khôi phục, import,
  kích hoạt, lưu trữ và xoá. Route kiểm tra lại sau guard, nên quy tắc giữ
  nguyên ở bất kỳ mount nào.
- Chưa hỗ trợ tác giả skill được uỷ quyền (không phải admin): không có
  capability nào cho phép người không phải admin ghi skill. `riskClass` cũng
  không thay đổi ai được ghi; nó là nhãn giúp người duyệt quyết định xem gì
  trước. Dùng `high` cho các playbook điều hướng hành vi hệ trọng (nội dung giá,
  câu chữ pháp lý, bất cứ thứ gì một agent mức autopilot sẽ hành động mà không
  qua duyệt).
- Skill mới luôn được tạo ở `draft`. Skill được import giữ `draft` trừ khi lệnh
  import nói `activate`. Một lần import không bao giờ đổi nội dung của skill
  `active` trừ khi nó nói `updateActive` (xem [Skills as code](#skills-as-code)).
- Skill là chỉ dẫn được tin vì người được phép viết nó. Content, tài liệu truy
  xuất và tin nhắn chat không bao giờ trở thành skill, và chúng tiếp tục đi vào
  prompt dưới dạng dữ liệu không tin cậy.

## API

Mọi route nằm dưới `/api/v1/agent/skills`. `:id` nhận id hoặc slug.

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/` | Liệt kê skill. Tuỳ chọn `?status=draft\|active\|archived`. |
| `POST` | `/` | Tạo một draft. Body: các field front matter cộng `body`; tuỳ chọn `source`, `sourceRef`, `changeNote`. `201`; `409 CONFLICT` khi trùng slug. |
| `GET` | `/:id` | Một skill, kèm `document` (dạng Markdown). |
| `PATCH` | `/:id` | Cập nhật một phần; field bị bỏ qua được giữ nguyên. `expectedVersion` tuỳ chọn (`409 VERSION_MISMATCH` khi skill đã sang phiên bản khác). `meta.changed` là `false` khi không có gì đổi. `slug` không đổi được. |
| `DELETE` | `/:id` | Xoá một skill chưa từng active, cùng vết phiên bản của nó. Có audit. `409 SKILL_HAS_BEEN_ACTIVE` với skill đã từng được kích hoạt — hãy lưu trữ nó. |
| `POST` | `/:id/activate` · `/:id/archive` · `/:id/draft` | Đổi status. Body tuỳ chọn `{ version }` (`409 VERSION_MISMATCH` khi skill đã sang phiên bản khác). |
| `GET` | `/:id/versions` | Vết phiên bản, mới nhất trước. |
| `POST` | `/:id/versions/:version/restore` | Ghi nội dung của một phiên bản cũ thành phiên bản mới. |
| `POST` | `/import` | Upsert tài liệu Markdown theo slug. Body `{ documents: [{ path?, content }], activate?, dryRun?, updateActive?, source?, sourceRef? }`, 1–100 tài liệu. Trả một kết quả cho mỗi tài liệu (`created`, `updated`, `unchanged`, `error`) và số đếm trong `meta`. Một tài liệu hỏng không huỷ phần còn lại. Một thay đổi nội dung với skill `active` là lỗi của tài liệu đó (`ACTIVE_SKILL_CHANGE`) trừ khi `updateActive` là `true`. |
| `GET` | `/export` | Mọi skill dưới dạng `{ slug, filename, status, version, hash, content }`. Import lại một bản export là no-op. |
| `POST` | `/match` | Xem trước. Body `{ surface, tool?, collection?, text? }`; trả `{ skills, skipped, prompt }` được đánh giá bằng capability của người gọi. |

Lỗi dùng envelope chuẩn: `VALIDATION` (400), `INVALID_DOCUMENT` và
`ACTIVE_SKILL_CHANGE` (theo từng tài liệu, trong kết quả import), `FORBIDDEN`
(403, không phải control-plane admin), `NOT_FOUND` (404), `CONFLICT`,
`VERSION_MISMATCH` và `SKILL_HAS_BEEN_ACTIVE` (409).

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
lưu được báo `unchanged` và không ghi gì.

`push` là đường deploy — thư mục là nguồn sự thật — nên nó gửi
`updateActive: true` và thay đổi của nó với skill `active` có hiệu lực ngay.

`install` đọc skill từ một package đã cài cục bộ (`package.json` →
`lumibase.skills`, mặc định `skills/`) hoặc từ một đường dẫn; nó không tải gì
về. Skill mới tới ở dạng draft để con người rà soát trong Studio (trừ khi có
`--activate`), và `install` không bao giờ đổi một skill đang active: tài liệu
như vậy được báo `ACTIVE_SKILL_CHANGE` và skill đang chạy được giữ nguyên.

Token cần quyền control-plane admin trên site và được đọc từ `LUMIBASE_TOKEN`,
không bao giờ từ file config. Xem [CLI](../cli/index.md).

## Studio

**Mission Control → Skills** liệt kê skill cùng status, risk class và phạm vi;
sửa front matter và thân Markdown; kích hoạt, lưu trữ và xoá; hiện vết phiên
bản kèm khôi phục; và có panel **Test match** gọi `/match` để bạn thấy một yêu
cầu mẫu sẽ nhận những skill nào. Lưu và kích hoạt gửi kèm phiên bản bạn đang
xem, nên một bản sửa mới hơn của người khác được báo lại thay vì bị ghi đè.
**Delete** chỉ được đưa ra cho skill chưa từng active; với các skill còn lại,
hãy lưu trữ.

## MCP

Khi bật flag `contentOs.mcp`, endpoint MCP quảng bá capability `prompts`.
`prompts/list` trả các skill active được đưa ra cho người gọi (`name` là slug);
`prompts/get` trả phần thân dưới dạng một user message duy nhất.

Prompt chỉ được phục vụ cho người gọi có thể đọc skill qua REST: một principal
được resolve thành control-plane admin của site. Với mọi người khác — một member
không phải admin, một site API key — `prompts/list` rỗng. Trên đó, `surfaces` và
`requiredCapabilities` của từng skill vẫn lọc những gì admin thấy. Một prompt
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
