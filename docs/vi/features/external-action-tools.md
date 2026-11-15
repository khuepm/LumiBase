---
version: 2
lastUpdated: 2026-11-15T12:16:36.578Z
sourceLang: en
translatedFrom: en
sourceHash: f546435ef3f2214a
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-15T12:16:36.578Z
codeVerifiedHash: f546435ef3f2214a
codeVerifiedClaims: 24
---

# External-action tools

Mọi skill dựng sẵn của agent đều tác động lên nội dung, schema hoặc cấu hình mà
LumiBase lưu trữ. **External-action tool** là tool của agent có tác động rơi vào
nơi khác: nó gọi một API bên ngoài CMS. Harness không nhìn thấy lời gọi đó đã đổi
gì và không hoàn tác được, nên tool phải tự khai những điều mà nếu không harness
sẽ phải đoán, và harness quyết định dựa trên bản khai đó.

LumiBase cung cấp cơ chế và một tool tham chiếu dùng cho test. Bản thân LumiBase
không đăng ký external-action tool nào.

Mã nguồn: `apps/cms/src/services/external-action-tools.ts` (bản khai, registry,
quy tắc quyết định), `apps/cms/src/services/ai-harness.ts` (quyết định và thực
thi), `apps/cms/src/services/tool-secret-service.ts` (bí mật),
`apps/cms/src/services/external-action-audit.ts` (hàng audit),
`apps/cms/src/services/external-action-policy.ts` (policy trước khi thực thi).

## Tool khai những gì

```ts
import { externalActionTools } from './services/external-action-tools';

externalActionTools.register({
  name: 'ticketComment',
  description: 'Adds a comment to a ticket in the tracker.',
  capability: 'tickets:comment',
  risk: 'medium',
  reversibility: 'reversible',
  blastRadius: { scope: 'single' },
  secrets: ['TRACKER_API_TOKEN'],
  inputSchema: {
    type: 'object',
    properties: {
      ticket: { type: 'string', maxLength: 64 },
      body: { type: 'string', maxLength: 4000 },
    },
    required: ['ticket', 'body'],
  },
  handler: async (args, context) => {
    const token = context.secret('TRACKER_API_TOKEN');
    // call the tracker with `token`; return a result without it
    return { ok: true };
  },
});
```

| Trường | Giá trị | Ý nghĩa |
|---|---|---|
| `capability` | `namespace:action` | Capability duy nhất mà bên gọi phải có. `*` và `admin` không phải bản khai hợp lệ |
| `risk` | `low`, `medium`, `high` | Một lời gọi sai gây hậu quả nặng tới đâu |
| `reversibility` | `read_only`, `reversible`, `irreversible` | Tác động có hoàn tác được bằng một lời gọi sau đó hay không |
| `blastRadius` | `none`, `single`, `bounded` (kèm `maxAffected`), `broad` | Một lời gọi chạm tới bao nhiêu bên ngoài |
| `secrets` | tên khớp `^[A-Z][A-Z0-9_]{1,63}$` | Các bí mật handler cần, khai theo tham chiếu |
| `inputSchema` | JSON Schema, `type: "object"` | Tham số; được kiểm trước khi có run hay approval |
| `policy` | tuỳ chọn, xem [Policy trước khi thực thi](#policy-trước-khi-thực-thi) | Constitution của site có được đánh giá trước khi tool chạy hay không |

Việc đăng ký từ chối một bản khai tự mâu thuẫn: tool `read_only` phải khai
`blastRadius.scope: "none"`, tool có tác động không được khai `none`, và blast
radius `broad` phải được khai rủi ro `high`. Tool không được lấy tên của một
skill dựng sẵn.

Role policy mô tả quyền trên nội dung và schema, nên hiện nay một capability như
`tickets:comment` chỉ có ở principal có quyền quản trị. Agent role thu hẹp tập đó
về các capability mà role liệt kê (`role ∩ caller`); đó là cách một agent nhận
được một tool mà không nhận phần quyền còn lại của quản trị viên.

Registry nằm trong bộ nhớ và dùng chung cho cả tiến trình, vì tool là mã. Thứ
tách theo site là mọi thứ quyết định một lời gọi có được chạy hay không:
capability của bên gọi, autonomy grant, hàng override trong `agent_tools` (có thể
tắt hoặc giới hạn tần suất một tool cho một site) và bí mật của tool.

## Một lời gọi được quyết định thế nào

External-action tool đi qua đúng các cổng mà mọi tool call đi qua, theo đúng thứ
tự: kill switch, kiểm tham số, capability, tool policy. Bước rủi ro sau đó lấy từ
bản khai (`governanceFor`):

| Bản khai | L0 | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| `read_only` | chạy chỉ dựa trên capability; không nằm trên thang autonomy |||||
| rủi ro `high`, hoặc `irreversible` | từ chối | approval | approval | approval | approval |
| rủi ro `medium`, hoàn tác được | từ chối | approval | approval | approval | chạy |
| rủi ro `low`, hoàn tác được | từ chối | approval | chạy | chạy | chạy |

- Tool rủi ro cao hoặc không hoàn tác được **luôn** chờ approval. Không autonomy
  grant, intent cap hay override `agent_tools` nào thay đổi điều đó.
- Khi không có autonomy grant cho `(agent role, capability)`, mức là **L1**: một
  tác động ra ngoài không bao giờ tự động chỉ vì chưa ai cấu hình grant.
- L3 không đưa external action vào veto window. Vùng chờ tồn tại cho các patch
  nội dung, vốn hoàn tác được; một lời gọi ra ngoài thì không.
- Tool chỉ chạy qua đường có quản trị. Gọi thẳng `runSkill` và một harness không
  bật audit run đều từ chối nó với `EXTERNAL_TOOL_UNGOVERNED`.

### Ai được duyệt

Approval được tạo cho một external-action tool được lưu với
`approvalPolicy: "human_required"` và chỉ một **người dùng đã đăng nhập** mới
giải phóng được. Các trường hợp sau bị từ chối với `HUMAN_APPROVAL_REQUIRED`, bất
kể capability:

- API key, kể cả organization key;
- OAuth access token cấp cho một MCP connector;
- agent reviewer (`POST /api/v1/agent/approvals/:id/agent-decide`), cả khi
  `contentOs.agentReview` đang bật;
- phiên của end-user phía frontend;
- bên gọi không nêu mình là ai.

Quy tắc được kiểm trên cả bản khai hiện tại của tool lẫn policy lưu trên
approval, nên đăng ký lại tool với bản khai nhẹ hơn không gỡ được quy tắc cho các
approval đã tạo. Mọi điều khác của một quyết định giữ nguyên: cần
`approvals:decide`, thực thi với capability `requester ∩ decider`, và site hoặc
role đang đóng băng thì từ chối.

Principal nào được quyết định approval thì vẫn **từ chối** được một approval.

## Policy trước khi thực thi

Tool có thể khai một `policy`. Khi đó constitution của site (bộ evaluator có
phiên bản mô tả trong tài liệu Content OS) được đánh giá trên mọi lời gọi của
tool, trên một bản ghi phẳng mô tả lời gọi đó:

```ts
policy: {
  constitution: 'required',               // or 'if_active'
  constitutionHashes: ['sha256:…'],       // optional: the only versions accepted
  record: (args, facts) => ({             // optional: default is the arguments
    body: args.body,
    intentRef: facts.intentId,
  }),
},
```

| Trường | Ý nghĩa |
|---|---|
| `constitution: 'required'` | Lời gọi bị từ chối trừ khi site có constitution đang active. Đóng khi lỗi (fail closed) |
| `constitution: 'if_active'` | Được đánh giá khi site có constitution đang active; chạy bình thường khi không có |
| `constitutionHashes` | Constitution đã ghim vào run phải có một trong các hash này. Phiên bản nào khác cũng làm lời gọi bị từ chối (`CONSTITUTION_NOT_ACCEPTED`) |
| `record(args, facts)` | Dựng bản ghi mà evaluator đọc. Evaluator rule chỉ đọc trường cấp một, nên hãy giữ nó phẳng |

Harness luôn thêm các dữ kiện của chính nó vào bản ghi, sau các trường của tool,
nên tool hay tham số không ghi đè được: `tool`, `capability`, `risk`,
`blastRadius` (phạm vi), `agentName`, `agentRole`, `intentId` và `runId`.

Khi nào việc đánh giá diễn ra:

- **Trước khi bất kỳ điều gì khác về lời gọi được quyết định.** Sau các cổng kill
  switch, kiểm tham số, capability, tool policy và bước kiểm L0, trước khi tạo
  approval hoặc để tool tự chạy.
- **Một lần nữa trước khi một lời gọi đã duyệt được thực thi.** Nếu policy lúc đó
  từ chối (constitution đã bị tắt, hoặc lời gọi nay vi phạm một quy tắc),
  approval được trả về `pending`, giống như khi site đang đóng băng, và không có
  gì chạy.

Một run được đánh giá theo constitution đã ghim vào nó, kể cả sau khi một phiên
bản mới hơn được kích hoạt. Policy `required` vẫn từ chối trên site không còn
phiên bản active nào, nên tắt constitution sẽ dừng mọi lời gọi có quản trị, kể cả
của các run đang chạy dở.

Kết quả:

| Kết quả | Điều gì xảy ra | Mã |
|---|---|---|
| mọi evaluator chặn đều đạt | quyết định tiếp tục như bảng ở trên | không có |
| một evaluator chặn không đạt | bị từ chối, ở mọi mức autonomy | `CONSTITUTION_VIOLATION` |
| chỉ các evaluator có `onViolation: "require_approval"` không đạt | chờ người duyệt, kể cả ở mức mà lẽ ra tool đã tự chạy; tool `read_only` cũng vậy | không có (`pending_approval`) |
| một evaluator chặn bị lỗi (regex sai, `llm_judge` không có LLM) | bị từ chối, bất kể `onViolation` | `CONSTITUTION_VIOLATION` |
| `required` và không có constitution active | bị từ chối; không tạo approval | `CONSTITUTION_REQUIRED` |
| phiên bản đã ghim không nằm trong `constitutionHashes` | bị từ chối | `CONSTITUTION_NOT_ACCEPTED` |
| `record` ném lỗi hoặc trả về thứ không phải object | bị từ chối | `POLICY_RECORD_INVALID` |

`onViolation` là trường tuỳ chọn của một evaluator (`block`, mặc định, hoặc
`require_approval`). Nó thuộc về constitution và nằm trong hash của nó. Cổng
publish coi cả hai giá trị là chặn.

Thông báo từ chối nêu tên các evaluator không đạt, không bao giờ trích nội dung
lời gọi: lý do của một `llm_judge` có thể trích tham số, nên không được trả về.

Tool không khai `policy` thì không được đánh giá và chạy y như trước.

## Nạp tool từ một gói

Entry của một deployment bọc CMS có thể trao tool từ một gói nằm ngoài repository
này qua platform seam `externalActions`, thay vì để CMS import chúng:

```ts
import { registerPlatformSeams } from '@lumibase/cms/platform';
import { myTools } from 'my-tools-package';

registerPlatformSeams({
  externalActions: { tools: () => myTools() },
});
```

- `tools()` được gọi một lần, bên trong `registerPlatformSeams()`. Mọi định nghĩa
  được kiểm và đăng ký vào registry dùng chung của tiến trình ngay tại đó, nên
  harness, `tools/list` và MCP thấy cùng một bộ tool từ request đầu tiên.
- Tất cả hoặc không gì cả: nếu một định nghĩa sai dạng hoặc một tên đã bị dùng,
  không tool nào được đăng ký và `registerPlatformSeams()` ném lỗi. Một
  deployment không được chạy với một nửa bộ tool.
- Các entry dựng sẵn (`cloudflare.ts`, `serve.ts`) không bao giờ đăng ký gì: không
  có đăng ký thì registry rỗng và danh mục skill là danh mục dựng sẵn, không đổi.

Xem [Điểm mở rộng nền tảng](../architecture/platform-extension-points.md).

## Bí mật

Tool nêu tên các bí mật của nó; quản trị viên lưu giá trị theo từng site:

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/api/v1/agent/tool-secrets` | Tên, phiên bản khoá và mốc thời gian. Không bao giờ trả giá trị |
| `PUT` | `/api/v1/agent/tool-secrets/:name` | Body `{ "value": "…" }` (8 đến 8192 ký tự). Lưu hoặc thay thế |
| `DELETE` | `/api/v1/agent/tool-secrets/:name` | Xoá bí mật |

Cả ba đều cần một quản trị viên site đã đăng nhập. API key bị từ chối kể cả khi
có quyền quản trị: agent không được phép cài hoặc tráo bí mật mà một tool sẽ
dùng.

- Giá trị được mã hoá bằng `KeyProvider` của runtime (cùng envelope có phiên bản
  như deployment token, nên xoay khoá vẫn áp dụng) và gắn với site và tên của nó.
  Không route nào trả lại giá trị.
- Giá trị được giải mã ngay trước khi handler chạy, và chỉ tồn tại trong đối
  tượng context mà handler nhận. Nó không nằm trong tham số, prompt, kết quả
  tool, tool call đã lưu, run, approval hay các hàng audit.
- Mọi thứ handler trả về hoặc ném ra đều được lọc bỏ các giá trị đã giải mã (dạng
  thô, URL-encoded và base64) trước khi rời harness. Giá trị bị lộ trở thành
  `[secret:NAME]`.
- Handler chỉ đọc được những tên mà tool của nó đã khai.
- Bí mật chưa được cấu hình làm lời gọi thất bại **trước khi** handler bắt đầu
  (`SECRET_MISSING`, nêu tên tham chiếu). Chưa có gì xảy ra bên ngoài, nên
  approval ở trạng thái đó quay về `pending` và thử lại được sau khi đặt bí mật.

Handler lỗi sau khi đã bắt đầu để lại một lượng việc không xác định. Như mọi hành
động đã được duyệt, approval khi đó dừng ở `failed` và một người mở lại nó sau
khi kiểm tra điều gì đã xảy ra.

## Audit

Mỗi bước ghi một hàng `lumibase_activity` cho site:

| `action` | Khi nào |
|---|---|
| `agent.external_action.proposed` | Lời gọi được đưa vào hàng chờ approval |
| `agent.external_action.approved` | Một người dùng giải phóng nó. Được ghi **trước khi** handler chạy; nếu lần ghi này lỗi, handler không bắt đầu |
| `agent.external_action.rejected` | Người quyết định từ chối nó |
| `agent.external_action.refused` | Harness không chạy hoặc không giải phóng nó (L0, người quyết định không phải người, phạm vi đang đóng băng, policy trước khi thực thi) |
| `agent.external_action.executed` | Handler trả về |
| `agent.external_action.failed` | Handler ném lỗi hoặc hết thời gian |
| `agent.tool_secret.set` / `agent.tool_secret.deleted` | Một bí mật được lưu hoặc xoá (chỉ có tên) |

Payload chứa tên tool, bản khai của nó (`capability`, `risk`, `reversibility`,
`blastRadius`, `secretRefs`), agent, id của run, tool call và approval, mức
autonomy, loại người quyết định, digest `sha256` của tham số (`inputHash`) và
hash của constitution đã ghim vào run. Với tool có policy, payload còn chứa
`policy`: kết quả, mã từ chối, hash của phiên bản được đánh giá, và id, trạng thái
cùng cờ `blocking` của từng evaluator. Nó không bao giờ chứa giá trị tham số,
thông báo của evaluator hay đầu ra của handler. Bản ghi run, tool call và approval được ghi như với mọi tool
call.

## MCP

`tools/call` tới một external-action tool qua đúng `AISecureHarness.execute` mà
Agent API dùng, nên quyết định là một. Property test về parity phủ loại tool này,
và một integration test so hai đường trên harness thật cho mọi tổ hợp rủi ro,
tính hoàn tác, mức autonomy và capability.

`tools/list` chỉ quảng bá một external-action tool cho bên gọi có capability của
nó. `GET /api/v1/agent/tools` liệt kê mọi tool đã đăng ký kèm bản khai dưới
`external`.

OAuth connector token bị thu hẹp theo scope như với tool dựng sẵn. Token của quản
trị viên thiếu bất kỳ MCP scope nào bị thu hẹp về tập capability dựng sẵn, nên
không gọi được external-action tool.

## Tool tham chiếu

`createHttpEchoTool` (`apps/cms/src/services/external-action-reference-tool.ts`)
gửi một thông điệp tới một endpoint và trả về phản hồi. Nó nhận endpoint và
`fetch` qua tham số và không được đăng ký ở đâu cả; bộ test đưa cho nó một
`fetch` trong bộ nhớ. Dùng nó làm mẫu cho một tool thật.

## Multi-tenancy

| Tài nguyên | Phạm vi |
|---|---|
| Định nghĩa tool (mã) | Dùng chung cả deployment: handler là mã, không phải dữ liệu tenant |
| Bí mật của tool (`lumibase_agent_tool_secrets`) | Theo site. Unique trên `(site_id, name)`, có trong `rls-policies.sql`, ciphertext gắn với site và tên |
| Autonomy grant, override `agent_tools`, approval, run, tool call, hàng audit | Theo site, như với mọi tool call |

Được kiểm bởi `external-action-tools.db.integration.test.ts`: grant trên một site
không áp dụng cho site khác, bí mật đặt trên một site thì thiếu ở site khác,
ciphertext chép sang hàng của site khác không giải mã được, approval tạo trên một
site không duyệt hay từ chối được từ site khác, và không run, tool call hay hàng
audit nào xuất hiện trên site không hành động.

## Giới hạn

- Trần tiền hoặc trần số lượng không thuộc cơ chế này. Tool khai blast radius;
  không có gì ở đây đếm chi tiêu hay số người nhận qua nhiều lời gọi.
- Policy trước khi thực thi là tuỳ chọn theo từng tool. Tool đăng ký không kèm
  policy chỉ được quản trị bằng bản khai của nó, kể cả trên site có constitution
  đang active.
- Evaluator `llm_judge` cần harness có LLM đã cấu hình. Không có thì nó báo lỗi,
  và một judge chặn khi đó từ chối mọi lời gọi (fail closed).
- Ranh giới đóng băng là tool call: handler đang chạy không bị ngắt. Hãy viết
  tool sao cho một lời gọi làm đúng một việc có giới hạn.
- Tool được đăng ký trong mã lúc tiến trình khởi động, trực tiếp hoặc qua seam
  `externalActions`. Không có API để thêm tool lúc chạy.

## Nâng cấp

Migration `0030_agent_tool_secrets` thêm một bảng theo site. Không backfill. Bản
cài hiện có không cần thao tác; không có gì thay đổi cho tới khi một tool được
đăng ký. `executeApproved` nhận tham số thứ tư nêu người quyết định. Bên gọi bỏ
qua tham số này vẫn chạy với skill dựng sẵn và bị từ chối với approval chỉ dành
cho người.

Policy trước khi thực thi và seam `externalActions` không cần migration và không
thay đổi gì với tool không khai policy hay với deployment không đăng ký seam.
Evaluator của constitution nhận thêm trường tuỳ chọn `onViolation`; các phiên bản
hiện có giữ nguyên hash.
