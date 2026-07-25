# Requirements Document

## Introduction

Tài liệu yêu cầu cho hệ thống **AI-First CMS Engine** của LumiBase. Hệ thống cho phép AI Agent tương tác an toàn với CMS thông qua cơ chế Human-in-the-Loop (HITL), bao gồm: lớp điều phối an toàn (AI Secure Harness), API HTTP cho giao tiếp AI, và giao diện Studio cho quản trị viên chat với AI cũng như phê duyệt hành động nguy hiểm.

## Glossary

- **AI_Harness**: Dịch vụ điều phối an toàn (AI Secure Harness) — lớp trung gian kiểm tra quyền hạn, đánh giá rủi ro và quyết định thực thi hoặc tạm giữ hành động AI chờ duyệt.
- **HITL_System**: Hệ thống Human-in-the-Loop — quy trình yêu cầu con người phê duyệt trước khi AI thực thi các hành động nguy hiểm.
- **Approval_Record**: Bản ghi phê duyệt — một hàng trong bảng `ai_approvals` lưu trữ thông tin về hành động AI đang chờ duyệt hoặc đã được xử lý.
- **Skill**: Một hành động cụ thể mà AI có thể thực thi (ví dụ: tạo collection, xóa item, đọc dữ liệu).
- **Capability**: Quyền hạn được cấp cho người dùng hoặc phiên làm việc (ví dụ: `schema:write`, `items:read`).
- **Risk_Evaluator**: Thành phần trong AI_Harness đánh giá mức độ rủi ro của một Skill dựa trên Capability yêu cầu.
- **Studio_UI**: Giao diện quản trị web của LumiBase dành cho quản trị viên.
- **AI_Chat_Panel**: Component giao diện chat nổi (floating) trong Studio_UI cho phép quản trị viên giao tiếp với AI bằng ngôn ngữ tự nhiên.
- **Approvals_Dashboard**: Màn hình trong Studio_UI hiển thị danh sách hành động AI đang chờ phê duyệt.
- **Site**: Đơn vị multi-tenancy trong LumiBase — mỗi site là một tenant độc lập.

## Requirements

### Requirement 1: Lưu trữ bản ghi phê duyệt AI

**User Story:** Là một quản trị viên, tôi muốn hệ thống lưu trữ các yêu cầu phê duyệt hành động AI vào cơ sở dữ liệu, để tôi có thể xem xét và quyết định phê duyệt hoặc từ chối.

#### Acceptance Criteria

1. THE HITL_System SHALL lưu trữ mỗi Approval_Record trong bảng `ai_approvals` với các trường: id (khóa chính, text, sinh tự động bằng nanoid 21 ký tự), siteId (text, bắt buộc, tham chiếu đến bảng sites), agentName (text, bắt buộc, mặc định 'lumibase-copilot'), skillName (text, bắt buộc), arguments (jsonb, bắt buộc, mặc định {}), status (text, bắt buộc, một trong ba giá trị: 'pending', 'approved', 'rejected'), context (text, tùy chọn), createdAt (timestamp, bắt buộc, mặc định thời điểm hiện tại), decidedAt (timestamp, tùy chọn), decidedBy (text, tùy chọn, tham chiếu đến bảng users).
2. THE HITL_System SHALL tạo index trên cặp trường (siteId, status) để tối ưu truy vấn lọc theo site và trạng thái.
3. WHEN một Approval_Record được tạo mà không cung cấp giá trị status, THE HITL_System SHALL gán giá trị mặc định 'pending' cho trường status.
4. WHEN site bị xóa, THE HITL_System SHALL xóa tất cả Approval_Record có siteId tương ứng theo cơ chế cascade (onDelete: 'cascade' trên foreign key siteId).
5. IF decidedBy được cung cấp và user tương ứng bị xóa, THEN THE HITL_System SHALL gán giá trị null cho trường decidedBy (onDelete: 'set null').
6. THE HITL_System SHALL sử dụng hàm nanoid (từ thư viện nanoid) với độ dài mặc định 21 ký tự để sinh giá trị id duy nhất cho mỗi Approval_Record thông qua $defaultFn.

### Requirement 2: Đánh giá rủi ro và kiểm tra quyền hạn

**User Story:** Là một quản trị viên, tôi muốn hệ thống tự động đánh giá mức độ rủi ro của hành động AI, để các hành động nguy hiểm phải được phê duyệt trước khi thực thi.

#### Acceptance Criteria

1. WHEN AI yêu cầu thực thi một Skill, THE AI_Harness SHALL kiểm tra Skill đó có tồn tại trong danh sách CORE_SKILLS đã đăng ký hay không.
2. IF Skill không tồn tại trong danh sách CORE_SKILLS đã đăng ký, THEN THE AI_Harness SHALL trả về trạng thái 'denied' kèm thông báo lỗi chỉ rõ tên Skill không hợp lệ.
3. WHEN AI yêu cầu thực thi một Skill hợp lệ, THE AI_Harness SHALL kiểm tra tất cả Capability yêu cầu của Skill có nằm trong danh sách Capability của phiên người dùng hiện tại hay không, trong đó Capability wildcard '*' được coi là thỏa mãn mọi Capability yêu cầu.
4. IF phiên người dùng thiếu bất kỳ Capability nào mà Skill yêu cầu và không sở hữu Capability wildcard '*', THEN THE AI_Harness SHALL trả về trạng thái 'denied' kèm thông báo chỉ rõ thiếu quyền.
5. WHEN Skill yêu cầu Capability 'schema:write' hoặc tên Skill bắt đầu bằng 'delete', THE Risk_Evaluator SHALL phân loại hành động đó là nguy hiểm và yêu cầu phê duyệt HITL.
6. WHEN hành động được phân loại là nguy hiểm, THE AI_Harness SHALL tạo một Approval_Record mới chứa siteId, skillName, arguments, context và trạng thái 'pending', sau đó trả về trạng thái 'pending_approval' kèm approvalId.
7. WHEN hành động được phân loại là an toàn và người dùng có đủ Capability, THE AI_Harness SHALL thực thi Skill trực tiếp và trả về trạng thái 'executed' kèm kết quả thực thi.
8. IF việc thực thi Skill trực tiếp gặp lỗi, THEN THE AI_Harness SHALL trả về trạng thái 'denied' kèm thông báo lỗi mô tả nguyên nhân thất bại, và không thay đổi trạng thái dữ liệu hiện tại.
9. THE AI_Harness SHALL hoàn tất toàn bộ quy trình đánh giá rủi ro và kiểm tra quyền hạn trong thời gian không quá 2000 mili giây kể từ khi nhận yêu cầu.

### Requirement 3: Thực thi hành động sau phê duyệt

**User Story:** Là một quản trị viên, tôi muốn hệ thống thực thi hành động AI sau khi tôi phê duyệt, để quy trình làm việc được liền mạch.

#### Acceptance Criteria

1. WHEN quản trị viên phê duyệt một Approval_Record, THE AI_Harness SHALL thực thi Skill tương ứng với arguments đã lưu trong bản ghi và trả về kết quả trong thời gian tối đa 30 giây.
2. WHEN Skill được thực thi thành công (trả về kết quả không phải exception) sau phê duyệt, THE AI_Harness SHALL cập nhật trạng thái Approval_Record thành 'approved', ghi nhận decidedAt và decidedBy, đồng thời trả về status 'executed' kèm dữ liệu kết quả từ Skill.
3. IF Approval_Record không tồn tại hoặc trạng thái không phải 'pending', THEN THE AI_Harness SHALL trả về trạng thái 'denied' kèm thông báo chỉ rõ yêu cầu không hợp lệ hoặc đã được xử lý, và không thay đổi bất kỳ dữ liệu nào trong hệ thống.
4. THE AI_Harness SHALL chỉ truy vấn Approval_Record thuộc siteId hiện tại để đảm bảo cách ly multi-tenancy.
5. IF Skill thực thi thất bại (ném exception hoặc vượt quá 30 giây timeout), THEN THE AI_Harness SHALL giữ nguyên trạng thái Approval_Record là 'pending', trả về status 'denied' kèm thông báo mô tả lỗi xảy ra, và không thay đổi dữ liệu hệ thống.

### Requirement 4: API nhận lệnh chat từ AI Assistant

**User Story:** Là một quản trị viên, tôi muốn gửi tin nhắn bằng ngôn ngữ tự nhiên đến AI thông qua API, để AI phân tích ý định và thực hiện hành động tương ứng.

#### Acceptance Criteria

1. WHEN Studio_UI gửi request POST đến endpoint `/api/v1/ai/chat` với body JSON chứa trường `message` (string, độ dài từ 1 đến 2000 ký tự, đã trim khoảng trắng đầu cuối), THE AI_Chat_API SHALL xác thực dữ liệu đầu vào theo Zod schema và chuyển sang bước phân tích ý định nếu hợp lệ.
2. IF trường `message` không tồn tại, không phải kiểu string, là chuỗi rỗng sau khi trim, hoặc vượt quá 2000 ký tự, THEN THE AI_Chat_API SHALL trả về HTTP 400 với body JSON chứa mảng `errors` mô tả lỗi validation cụ thể.
3. WHEN message hợp lệ được nhận, THE AI_Chat_API SHALL phân tích ý định (intent) để xác định tên Skill và arguments tương ứng trong thời gian không quá 10 giây.
4. IF quá trình phân tích ý định không thể xác định được Skill phù hợp từ message, THEN THE AI_Chat_API SHALL trả về HTTP 200 với body JSON chứa `status` là `"denied"` và trường `message` mô tả rằng hệ thống không nhận diện được hành động từ yêu cầu.
5. WHEN intent được xác định thành công với tên Skill và arguments, THE AI_Chat_API SHALL chuyển tiếp yêu cầu đến AI_Harness để đánh giá quyền hạn (Capabilities) và thực thi hoặc tạo yêu cầu chờ duyệt.
6. IF AI_Harness trả về lỗi trong quá trình thực thi, THEN THE AI_Chat_API SHALL trả về HTTP 500 với body JSON chứa mảng `errors` bao gồm mã lỗi và thông báo mô tả lỗi xử lý nội bộ.
7. WHEN AI_Harness hoàn tất xử lý thành công, THE AI_Chat_API SHALL trả về HTTP 200 với body JSON có cấu trúc `{ data: { status, data?, approvalId?, message? } }` trong đó `status` là một trong ba giá trị: `"executed"`, `"pending_approval"`, hoặc `"denied"`.

### Requirement 5: API quản lý danh sách phê duyệt

**User Story:** Là một quản trị viên, tôi muốn xem danh sách các hành động AI đang chờ phê duyệt, để tôi có thể đưa ra quyết định kịp thời.

#### Acceptance Criteria

1. WHEN quản trị viên gửi request GET đến endpoint `/api/v1/ai/approvals`, THE AI_Approvals_API SHALL trả về danh sách tối đa 100 Approval_Record có trạng thái 'pending' thuộc site hiện tại, sắp xếp theo trường createdAt từ mới nhất đến cũ nhất.
2. THE AI_Approvals_API SHALL chỉ trả về Approval_Record có siteId khớp với site của phiên đăng nhập hiện tại.
3. THE AI_Approvals_API SHALL trả về dữ liệu dưới dạng JSON với cấu trúc `{ data: [...] }`, trong đó mỗi phần tử chứa các trường: id, siteId, agentName, skillName, arguments, status, context, createdAt, decidedAt, decidedBy. WHEN không có Approval_Record nào ở trạng thái 'pending', THE AI_Approvals_API SHALL trả về `{ data: [] }`.
4. IF quản trị viên gửi request mà phiên đăng nhập không hợp lệ hoặc chưa xác thực, THEN THE AI_Approvals_API SHALL trả về mã HTTP 401 kèm thông báo lỗi cho biết yêu cầu xác thực.

### Requirement 6: API phê duyệt hoặc từ chối hành động AI

**User Story:** Là một quản trị viên, tôi muốn phê duyệt hoặc từ chối hành động AI thông qua API, để kiểm soát những gì AI được phép thực hiện.

#### Acceptance Criteria

1. WHEN quản trị viên gửi request POST đến endpoint `/api/v1/ai/approvals/:id/decide` với trường decision có giá trị 'approved', THE AI_Approvals_API SHALL gọi AI_Harness để thực thi hành động đã được phê duyệt, cập nhật trạng thái Approval_Record thành 'approved' cùng với decidedAt và decidedBy, và trả về kết quả thực thi trong response.
2. WHEN quản trị viên gửi request POST đến endpoint `/api/v1/ai/approvals/:id/decide` với trường decision có giá trị 'rejected', THE AI_Approvals_API SHALL cập nhật trạng thái Approval_Record thành 'rejected', ghi nhận decidedAt và decidedBy.
3. THE AI_Approvals_API SHALL chỉ xử lý Approval_Record có siteId khớp với site của phiên đăng nhập hiện tại.
4. THE AI_Approvals_API SHALL trả về kết quả dưới dạng JSON với cấu trúc `{ data: {...} }`.
5. IF trường decision có giá trị khác 'approved' hoặc 'rejected', THEN THE AI_Approvals_API SHALL từ chối request và trả về lỗi chỉ rõ các giá trị hợp lệ cho trường decision.
6. IF Approval_Record với id được chỉ định không tồn tại, không thuộc site hiện tại, hoặc không ở trạng thái 'pending', THEN THE AI_Approvals_API SHALL trả về lỗi chỉ rõ yêu cầu không hợp lệ hoặc đã được xử lý, và không thay đổi dữ liệu nào.
7. IF AI_Harness thực thi hành động thất bại sau khi được phê duyệt, THEN THE AI_Approvals_API SHALL trả về lỗi chỉ rõ nguyên nhân thất bại và không cập nhật trạng thái Approval_Record thành 'approved'.

### Requirement 7: Giao diện AI Chat Assistant

**User Story:** Là một quản trị viên, tôi muốn có một khung chat nổi trong Studio để giao tiếp với AI bằng ngôn ngữ tự nhiên, để tôi có thể ra lệnh cho AI mà không cần rời khỏi giao diện quản trị.

#### Acceptance Criteria

1. THE AI_Chat_Panel SHALL hiển thị dưới dạng nút bong bóng (floating button) có kích thước 48x48px ở góc dưới bên phải màn hình Studio_UI, cách mép dưới 24px và cách mép phải 24px.
2. WHEN quản trị viên click vào nút bong bóng, THE AI_Chat_Panel SHALL mở khung chat có chiều rộng 320px và chiều cao tối đa 480px với hiệu ứng backdrop-blur (glassmorphism).
3. WHEN quản trị viên nhập tin nhắn có độ dài từ 1 đến 1000 ký tự và gửi, THE AI_Chat_Panel SHALL hiển thị trạng thái đang xử lý (loading indicator) và gọi endpoint POST `/api/v1/ai/chat` với nội dung tin nhắn.
4. IF tin nhắn trống hoặc chỉ chứa khoảng trắng, THEN THE AI_Chat_Panel SHALL vô hiệu hóa nút gửi và không gọi API.
5. WHEN nhận được phản hồi thành công từ API, THE AI_Chat_Panel SHALL hiển thị kết quả trong danh sách tin nhắn với phân biệt vai trò 'user' và 'assistant', và ẩn trạng thái đang xử lý.
6. IF phản hồi từ API có trạng thái 'pending_approval', THEN THE AI_Chat_Panel SHALL hiển thị tin nhắn assistant kèm nhãn trực quan cho biết hành động đang chờ phê duyệt.
7. IF gọi API thất bại (lỗi mạng hoặc HTTP status >= 400), THEN THE AI_Chat_Panel SHALL ẩn trạng thái đang xử lý và hiển thị thông báo lỗi trong danh sách tin nhắn để quản trị viên biết yêu cầu không thành công.
8. THE AI_Chat_Panel SHALL duy trì tối đa 50 tin nhắn trong lịch sử hội thoại cho đến khi quản trị viên tải lại trang hoặc đăng xuất.
9. WHEN quản trị viên click vào nút bong bóng trong lúc khung chat đang mở, THE AI_Chat_Panel SHALL đóng khung chat.

### Requirement 8: Giao diện bảng phê duyệt hành động AI

**User Story:** Là một quản trị viên, tôi muốn có màn hình hiển thị danh sách hành động AI đang chờ phê duyệt dưới dạng thẻ (card), để tôi có thể xem chi tiết và đưa ra quyết định nhanh chóng.

#### Acceptance Criteria

1. THE Approvals_Dashboard SHALL hiển thị danh sách Approval_Record đang ở trạng thái 'pending' dưới dạng thẻ (card), tối đa 50 thẻ trên một lần tải.
2. THE Approvals_Dashboard SHALL hiển thị trên mỗi thẻ: tên Skill (trường `skillName`), arguments dưới dạng JSON có thụt lề 2 dấu cách (pretty-printed), và ngữ cảnh (trường `context`) của yêu cầu.
3. THE Approvals_Dashboard SHALL cung cấp hai nút hành động trên mỗi thẻ: nút "Approve" và nút "Reject".
4. WHEN quản trị viên click nút "Approve", THE Approvals_Dashboard SHALL gọi endpoint POST `/api/v1/ai/approvals/:id/decide` với decision 'approved' và vô hiệu hóa cả hai nút trên thẻ đó cho đến khi nhận được phản hồi từ server.
5. WHEN quản trị viên click nút "Reject", THE Approvals_Dashboard SHALL gọi endpoint POST `/api/v1/ai/approvals/:id/decide` với decision 'rejected' và vô hiệu hóa cả hai nút trên thẻ đó cho đến khi nhận được phản hồi từ server.
6. WHEN hành động phê duyệt hoặc từ chối thành công (HTTP status 2xx), THE Approvals_Dashboard SHALL cập nhật giao diện bằng cách loại bỏ thẻ đã xử lý khỏi danh sách trong vòng 1 giây.
7. WHEN component được mount, THE Approvals_Dashboard SHALL gọi endpoint GET `/api/v1/ai/approvals` để tải danh sách phê duyệt và hiển thị trạng thái loading (spinner hoặc skeleton) trong khi chờ phản hồi.
8. IF endpoint GET `/api/v1/ai/approvals` trả về danh sách rỗng, THEN THE Approvals_Dashboard SHALL hiển thị thông báo cho biết không có hành động nào đang chờ phê duyệt.
9. IF lời gọi endpoint POST `/api/v1/ai/approvals/:id/decide` thất bại (HTTP status khác 2xx hoặc lỗi mạng), THEN THE Approvals_Dashboard SHALL hiển thị thông báo lỗi cho quản trị viên và giữ nguyên thẻ trong danh sách với các nút hành động được kích hoạt lại.

### Requirement 9: Đảm bảo cách ly multi-tenancy

**User Story:** Là một quản trị viên, tôi muốn đảm bảo dữ liệu AI của site tôi không bị truy cập bởi site khác, để bảo mật thông tin được đảm bảo.

#### Acceptance Criteria

1. THE AI_Harness SHALL bao gồm điều kiện lọc `WHERE siteId = <siteId hiện tại>` trong mọi câu truy vấn SELECT, UPDATE và DELETE đến bảng ai_approvals, trong đó siteId được lấy từ context của request đã được xác thực bởi tenant middleware.
2. WHEN AI_Harness tạo mới một Approval_Record (INSERT), THE AI_Harness SHALL gán giá trị siteId từ context của request hiện tại vào trường site_id của bản ghi trước khi ghi vào cơ sở dữ liệu.
3. THE AI_Approvals_API SHALL bao gồm điều kiện lọc `WHERE siteId = <siteId hiện tại>` trong mọi câu truy vấn (GET danh sách approvals, POST decide approval) đến bảng ai_approvals, đảm bảo không có endpoint nào trả về hoặc thao tác trên bản ghi thuộc siteId khác.
4. IF một request gửi đến AI_Approvals_API tham chiếu một approvalId tồn tại trong hệ thống nhưng không thuộc siteId hiện tại, THEN THE AI_Harness SHALL từ chối xử lý, không tiết lộ sự tồn tại của bản ghi đó, và trả về phản hồi lỗi với HTTP status 403 kèm thông báo cho biết yêu cầu không hợp lệ hoặc bản ghi không tồn tại.
5. IF siteId không được xác định trong context của request (tenant middleware không resolve được), THEN THE AI_Approvals_API SHALL từ chối toàn bộ request với HTTP status 400 và không thực thi bất kỳ truy vấn nào đến bảng ai_approvals.

### Requirement 10: Tuân thủ quy chuẩn kỹ thuật dự án

**User Story:** Là một lập trình viên, tôi muốn mã nguồn AI-First CMS Engine tuân thủ các quy chuẩn kỹ thuật của dự án LumiBase, để đảm bảo tính nhất quán và khả năng bảo trì.

#### Acceptance Criteria

1. THE AI_First_CMS_Engine SHALL sử dụng TypeScript strict mode (kế thừa từ `tsconfig.base.json` với `"strict": true` và `"noUncheckedIndexedAccess": true`) và không sử dụng kiểu `any` trừ trường hợp tương tác với thư viện bên thứ ba không có type definition, kèm theo comment giải thích lý do ngay trên dòng sử dụng.
2. THE AI_First_CMS_Engine SHALL sử dụng Hono framework cho tất cả HTTP route handler được đăng ký trong ứng dụng (bao gồm cả route công khai và route có xác thực).
3. THE AI_First_CMS_Engine SHALL sử dụng Drizzle ORM cho tất cả tương tác với cơ sở dữ liệu và không chứa câu truy vấn SQL thuần (raw SQL) trừ trường hợp Drizzle ORM không hỗ trợ, kèm comment giải thích.
4. IF mã nguồn được đề xuất gộp vào nhánh chính, THEN THE AI_First_CMS_Engine SHALL vượt qua toàn bộ pipeline CI bao gồm `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, và `pnpm -r build` mà không có lỗi hoặc cảnh báo TypeScript.
5. THE AI_First_CMS_Engine SHALL sử dụng Zod schema để xác thực dữ liệu đầu vào từ request body tại mọi endpoint API có nhận dữ liệu từ client (POST, PUT, PATCH), và trả về lỗi validation với mã HTTP 400 khi dữ liệu không hợp lệ.
6. THE AI_First_CMS_Engine SHALL sử dụng `nanoid` (độ dài 11-21 ký tự) cho tất cả Primary Key và bao gồm cột `site_id` trong mọi bảng dữ liệu miền (domain table) để đảm bảo multi-tenancy.
