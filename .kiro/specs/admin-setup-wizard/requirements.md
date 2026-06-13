# Requirements Document

## Introduction

Tài liệu yêu cầu cho **Admin Setup / First-Time Configuration Wizard** trong LumiBase Studio (`apps/studio`). Tính năng này hiện chưa tồn tại — Studio đang giả định hệ thống đã được khởi tạo và route thẳng vào AppShell. Wizard cung cấp luồng cấu hình lần đầu cho instance mới, gồm ba khối chính:

1. **Tạo tài khoản Bootstrap Admin** — email, mật khẩu, họ tên cơ bản.
2. **Cấu hình Admin Path tùy biến** — đường dẫn URL không thể đoán trước cho phần Studio (kiểu "Hide Login" của WordPress) nhằm giảm bề mặt tấn công của bot dò admin.
3. **Cấu hình Login Lockout & Anomaly Detection** — chính sách phát hiện hành vi đăng nhập bất thường, gồm ngưỡng thất bại theo user/IP, thời gian khoá, anomaly địa lý / thời gian / thiết bị, kênh thông báo và cơ chế recovery.

Wizard chỉ truy cập được khi instance ở trạng thái **Uninitialized** (chưa có Bootstrap Admin). Sau khi setup hoàn tất, route wizard trả 404. Studio cũng chỉ render được khi request đi qua Custom Admin Path đã cấu hình; mọi request đến path mặc định (`/admin`, `/studio`, …) hoặc path sai đều trả 404 mà không leak thông tin về sự tồn tại của Studio.

## Glossary

- **Studio**: Ứng dụng Admin UI tại `apps/studio` (React + TanStack Router).
- **CMS**: Backend Hono tại `apps/cms` phục vụ REST API ở prefix `/api/v1`.
- **Setup_Wizard**: Tập route + UI trong Studio chịu trách nhiệm chạy luồng cấu hình lần đầu, đặt tại `/setup` (mặc định) trong Studio.
- **Setup_Service**: Tập endpoint backend trong CMS (prefix `/api/v1/setup`) phục vụ Setup_Wizard.
- **System_State**: Trạng thái khởi tạo của instance, gồm hai giá trị `uninitialized` và `initialized`. Lưu persistently trong CMS database (bảng `system_state` hoặc tương đương).
- **Bootstrap_Admin**: Tài khoản admin đầu tiên được tạo qua Setup_Wizard. Khi Bootstrap_Admin tồn tại, System_State chuyển sang `initialized`.
- **Admin_Path**: Chuỗi URL slug do người dùng chọn làm điểm vào Studio, ví dụ `/lumi-7f3a9c`. Lưu persistently server-side, không bao giờ ghi vào client bundle.
- **Admin_Path_Guard**: Cơ chế ở CMS (và proxy/edge nếu có) so sánh path của request tới phạm vi Studio với Admin_Path đã cấu hình; trả 404 khi không khớp.
- **Default_Admin_Paths**: Danh sách path không được phép dùng làm Admin_Path vì dễ đoán: `/admin`, `/administrator`, `/studio`, `/wp-admin`, `/login`, `/dashboard`, `/cms`, `/api`, `/setup`, `/`.
- **Login_Guard**: Service ở CMS chặn request đăng nhập theo Lockout_Policy và Anomaly_Detector.
- **Lockout_Policy**: Tập tham số cấu hình hành vi khoá: `userMaxFailedAttempts`, `userLockoutDurationSeconds`, `ipMaxFailedAttempts`, `ipLockoutDurationSeconds`, `lockoutWindowSeconds`, `anomalyAction`, `notifyChannels`, …
- **Anomaly_Detector**: Service đánh giá độ bất thường của request đăng nhập trên các trục: địa lý, thời gian, thiết bị/User-Agent, IP reputation.
- **Anomaly_Score**: Số thực trong `[0, 1]` do Anomaly_Detector trả về cho một login attempt.
- **Anomaly_Action**: Hành động khi Anomaly_Score vượt ngưỡng — `none`, `require_mfa`, `lock`, `notify_only`.
- **Login_Attempt**: Bản ghi mỗi lần thử đăng nhập, gồm email, IP, User-Agent, timestamp, country (từ GeoIP), kết quả (success/fail), anomalyScore, lý do thất bại.
- **Login_Baseline**: Tập đặc trưng bình thường của một user (countries đã thấy, giờ đăng nhập điển hình theo timezone, fingerprint thiết bị) tích lũy từ các Login_Attempt thành công lịch sử.
- **Recovery_Token**: Mã một lần (single-use, time-bound) gửi qua kênh email backup để mở khoá tài khoản hoặc đặt lại Admin_Path.
- **Backup_Code**: Mã offline (8–10 ký tự) sinh khi setup, hash lưu DB, dùng một lần để vượt qua lockout khi email recovery không khả dụng.
- **Notification_Channel**: Kênh nhận thông báo bảo mật — `email`, `webhook`. Nhiều kênh có thể bật đồng thời.
- **Setup_Token**: Token một lần do CMS sinh khi instance ở trạng thái `uninitialized`, gắn vào URL khởi đầu wizard để tránh ai cũng tạo được Bootstrap_Admin nếu CMS bị expose. Không bắt buộc trong môi trường self-hosted local; bắt buộc khi `LUMIBASE_REQUIRE_SETUP_TOKEN=true`.
- **Audit_Log**: Bảng lưu sự kiện bảo mật của Setup_Wizard và Login_Guard.

## Requirements

### Requirement 1: Phát hiện trạng thái khởi tạo của instance

**User Story:** Là một người triển khai LumiBase, tôi muốn instance tự nhận biết đã được khởi tạo hay chưa, để wizard chỉ chạy đúng một lần và không thể bị lạm dụng để cướp quyền sau khi đã có admin.

#### Acceptance Criteria

1. THE CMS SHALL exposes endpoint `GET /api/v1/setup/state` trả về JSON `{ state: 'uninitialized' | 'initialized', requiresSetupToken: boolean }` mà không yêu cầu authentication.
2. WHEN không có Bootstrap_Admin nào tồn tại trong DB, THE Setup_Service SHALL trả `state: 'uninitialized'`.
3. WHEN có ít nhất một user có role `admin` và đánh dấu `is_bootstrap=true` trong DB, THE Setup_Service SHALL trả `state: 'initialized'`.
4. WHEN System_State đã là `initialized`, THE Setup_Service SHALL từ chối mọi POST tới `/api/v1/setup/*` với HTTP 404 và body `{ errors: [{ code: 'NOT_FOUND' }] }`.
5. THE Setup_Service SHALL chuyển System_State từ `uninitialized` sang `initialized` chỉ sau khi cả việc tạo Bootstrap_Admin và lưu Admin_Path đã commit thành công trong cùng một transaction; nếu bất kỳ operation nào trong transaction thất bại (kể cả khi DB transaction tự rollback), System_State SHALL giữ nguyên `uninitialized` và không entry side-effect (Audit_Log, notification) nào về việc setup hoàn tất được phát ra.
6. THE Setup_Service SHALL không expose chi tiết version, hostname, hoặc tenant identifier trong response của `GET /setup/state`.

### Requirement 2: Quyền truy cập Setup Wizard

**User Story:** Là một admin tiềm năng, tôi muốn truy cập Setup_Wizard chỉ khi instance chưa khởi tạo, để không có ai khác chạy lại wizard và cướp quyền sau này.

#### Acceptance Criteria

1. WHEN người dùng truy cập route `/setup` trong Studio, THE Studio SHALL gọi `GET /api/v1/setup/state` trước khi render bất kỳ field nào.
2. WHEN System_State trả về `initialized`, THE Setup_Wizard SHALL render trang 404 (không redirect tới Studio) và không hiển thị bất kỳ field nhập liệu nào.
3. WHEN System_State trả về `uninitialized` AND `requiresSetupToken=true` AND URL không chứa query `?token=<Setup_Token>` hợp lệ, THE Setup_Wizard SHALL hiển thị trang yêu cầu Setup_Token với hướng dẫn lấy token từ log của CMS.
4. WHEN System_State là `uninitialized` AND (`requiresSetupToken=false` OR Setup_Token hợp lệ), THE Setup_Wizard SHALL render bước đầu của luồng setup.
5. WHILE Setup_Wizard đang hoạt động, THE Studio SHALL không render AppShell của khu vực admin chính (sidebar modules, content list, …).
6. WHERE biến môi trường `LUMIBASE_REQUIRE_SETUP_TOKEN=true` được set, THE CMS SHALL sinh Setup_Token ngẫu nhiên (≥ 24 ký tự, entropy ≥ 128 bit) lúc startup khi System_State là `uninitialized` và in token vào stdout đúng một lần.
7. THE Setup_Token SHALL hết hạn ngay khi System_State chuyển sang `initialized`.

### Requirement 3: Tạo Bootstrap Admin

**User Story:** Là người setup instance, tôi muốn tạo tài khoản admin đầu tiên với email, mật khẩu và họ tên, để có lối vào Studio sau khi cấu hình xong.

#### Acceptance Criteria

1. THE Setup_Wizard SHALL có bước "Admin Account" yêu cầu các trường: `email` (RFC 5321 compliant), `password`, `confirmPassword`, `firstName`, `lastName`.
2. WHEN người dùng submit bước "Admin Account" với `email` không khớp regex email RFC 5322 simplified, THE Setup_Wizard SHALL hiển thị lỗi inline tại field `email` và không chuyển bước.
3. THE Setup_Wizard SHALL từ chối mật khẩu có độ dài < 12 ký tự, hoặc thiếu một trong các loại: chữ thường, chữ hoa, chữ số, ký tự đặc biệt thuộc tập `! @ # $ % ^ & * ( ) - _ = + [ ] { } ; : , . ? /`.
4. WHEN `password !== confirmPassword`, THE Setup_Wizard SHALL hiển thị lỗi tại `confirmPassword` và không chuyển bước.
5. THE Setup_Wizard SHALL hiển thị thanh đo độ mạnh mật khẩu dựa trên zxcvbn score (0–4) và yêu cầu score ≥ 3 trước khi cho phép submit bước.
6. THE Setup_Service SHALL hash mật khẩu bằng PBKDF2-SHA256 với ≥ 100,000 iterations và salt ngẫu nhiên ≥ 16 byte trước khi lưu DB (cùng scheme `pbkdf2$<iter>$<saltHex>$<hashHex>` mà `apps/cms/src/routes/auth.ts` đang dùng).
7. THE Setup_Service SHALL không bao giờ trả lại password hash hoặc plaintext password trong bất kỳ HTTP response, log line, error message, debug endpoint, hoặc kênh đầu ra nào khác của hệ thống.
8. WHEN bước "Admin Account" được submit thành công, THE Setup_Wizard SHALL lưu trạng thái cục bộ trong session (sessionStorage) và chuyển sang bước "Admin Path".
9. WHILE bước "Admin Account" chưa được submit thành công với mọi validation pass, THE Setup_Wizard SHALL chặn điều hướng sang bước "Admin Path" và mọi bước sau đó (nút "Next" disable, deep-link tới bước sau redirect về bước "Admin Account").

### Requirement 4: Cấu hình Custom Admin Path

**User Story:** Là người setup instance, tôi muốn chọn một URL bí mật cho Studio, để bot dò `/admin` không tìm thấy bề mặt admin.

#### Acceptance Criteria

1. THE Setup_Wizard SHALL có bước "Admin Path" với input `adminPath` và nút "Generate random path" sinh chuỗi ngẫu nhiên dạng `<word>-<6 ký tự hex>`.
2. THE Setup_Wizard SHALL chấp nhận chỉ Admin_Path khớp regex `^/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$` (slug bắt đầu bằng `/`, chữ thường, số, dấu gạch ngang; 4–64 ký tự sau dấu `/`).
3. IF Admin_Path đã chuẩn hóa nằm trong Default_Admin_Paths, THEN THE Setup_Wizard SHALL hiển thị lỗi "This path is too predictable. Choose another." và chặn submit ngay (không cho phép bypass bằng warning).
4. IF Admin_Path bắt đầu bằng `/api` hoặc `/setup` hoặc `/health` hoặc `/metrics` hoặc `/scim`, THEN THE Setup_Wizard SHALL chặn submit với lỗi rõ ràng (xung đột với route hệ thống).
5. THE Setup_Wizard SHALL hiển thị Admin_Path preview kèm cảnh báo "Lưu lại path này. Mất path đồng nghĩa cần chạy recovery flow."
6. THE Setup_Service SHALL lưu Admin_Path persistently server-side trong bảng `system_state` (cột `admin_path`) và đặt unique constraint ở phạm vi instance.
7. THE Setup_Service SHALL không bao giờ ghi Admin_Path vào HTML tĩnh, JS bundle, hoặc public asset; client phải fetch path từ endpoint authenticated.
8. THE Setup_Service SHALL chuẩn hóa Admin_Path về dạng `/<slug>` (lowercase, no trailing slash, single leading slash) trước khi chạy validation ở (2)–(4) và lưu DB; IF normalization thất bại (input không thể chuẩn hóa thành slug hợp lệ, ví dụ chỉ chứa whitespace hoặc ký tự control), THEN THE Setup_Wizard SHALL chặn submit và hiển thị lỗi "Invalid path format" trước khi chạy validation khác.

### Requirement 5: Route Guard cho Custom Admin Path sau khi setup

**User Story:** Là chủ instance, tôi muốn mọi request đến path đoán trước (`/admin`, `/studio`, …) trả 404 không phân biệt được với route không tồn tại, để attacker không xác nhận được Studio đang chạy ở đâu.

#### Acceptance Criteria

1. WHEN System_State là `initialized` AND người dùng request một path khác Admin_Path đã cấu hình mà path đó nằm trong Default_Admin_Paths, THE CMS SHALL trả HTTP 404 với body chuẩn `{ errors: [{ code: 'NOT_FOUND' }] }` giống mọi route 404 khác (cùng latency profile, không có header phân biệt).
2. WHEN người dùng request đúng Admin_Path AND đã authenticate, THE CMS SHALL phục vụ Studio HTML/asset bundle với header `Content-Type: text/html` và set internal response type marker `STUDIO_HTML` để observability/log có thể phân biệt với asset/API response.
3. WHEN người dùng request đúng Admin_Path AND chưa authenticate, THE Studio SHALL hiển thị màn hình login (chuyển sang requirement của Login_Guard ở Requirement 7).
4. WHEN System_State là `uninitialized`, THE Admin_Path_Guard SHALL bypass kiểm tra path và phục vụ Setup_Wizard tại `/setup`.
5. THE Admin_Path_Guard SHALL không ghi log chi tiết Admin_Path thực tế ở mức log mặc định (chỉ log hash hoặc placeholder `<admin_path>`); WHERE log level là `debug`, raw path SHALL được ghi.
6. WHEN người dùng request một path không trong Default_Admin_Paths và không trùng Admin_Path, THE CMS SHALL trả 404 chuẩn.
7. THE Admin_Path_Guard SHALL có constant-time string comparison khi so sánh path để tránh timing attack tiết lộ tiền tố.

### Requirement 6: Cấu hình Lockout & Anomaly Policy trong wizard

**User Story:** Là người setup instance, tôi muốn cấu hình ngưỡng lockout và anomaly detection ngay từ đầu, để hệ thống bảo vệ login từ phút đầu chạy.

#### Acceptance Criteria

1. THE Setup_Wizard SHALL có bước "Login Security" với form chia thành 4 nhóm: "Failed Attempts", "Geographic Anomaly", "Time Anomaly", "Device Anomaly", "Notifications".
2. THE Setup_Wizard SHALL cung cấp preset "Standard", "Strict", "Lenient" áp dụng các giá trị mặc định cho toàn bộ Lockout_Policy; preset "Standard" được chọn mặc định.
3. THE Lockout_Policy SHALL gồm các tham số sau, mỗi tham số có range hợp lệ và mặc định preset "Standard":
   - `userMaxFailedAttempts`: integer ∈ [3, 20], mặc định 5.
   - `userLockoutDurationSeconds`: integer ∈ [60, 86400], mặc định 900 (15 phút).
   - `ipMaxFailedAttempts`: integer ∈ [5, 100], mặc định 20.
   - `ipLockoutDurationSeconds`: integer ∈ [60, 86400], mặc định 3600 (60 phút).
   - `lockoutWindowSeconds`: integer ∈ [60, 86400], mặc định 900 (cửa sổ trượt đếm thất bại).
   - `geoAnomalyEnabled`: boolean, mặc định `true`.
   - `timeAnomalyEnabled`: boolean, mặc định `false`.
   - `deviceAnomalyEnabled`: boolean, mặc định `true`.
   - `anomalyScoreThreshold`: number ∈ [0, 1] với 2 chữ số thập phân, mặc định 0.70.
   - `anomalyAction`: enum `'notify_only' | 'require_mfa' | 'lock'`, mặc định `'notify_only'` (vì MFA chưa có ở giai đoạn này thì FE phải disable `'require_mfa'`).
   - `notifyChannels`: array các Notification_Channel, mặc định `['email']`.
4. WHEN người dùng nhập giá trị nằm ngoài range, THE Setup_Wizard SHALL hiển thị lỗi inline và chặn submit.
5. WHEN người dùng tick `geoAnomalyEnabled` (= `true`) AND CMS không có GeoIP database khả dụng (kiểm tra qua `GET /api/v1/setup/capabilities`), THE Setup_Wizard SHALL hiển thị warning "GeoIP unavailable; geographic anomaly detection sẽ tạm tắt cho đến khi cài đặt GeoIP." và vẫn cho lưu (không chặn). WHEN `geoAnomalyEnabled=false`, THE Setup_Wizard SHALL không hiển thị warning về GeoIP bất kể tình trạng GeoIP database.
6. THE Setup_Service SHALL lưu Lockout_Policy persistently dưới dạng JSON trong bảng `settings` với key `login_security_policy`.
7. THE Setup_Service SHALL áp dụng Lockout_Policy ngay sau khi commit transaction setup; không cần restart CMS.

### Requirement 7: Đếm thất bại theo user và lockout tài khoản

**User Story:** Là chủ instance, tôi muốn tài khoản admin bị khoá tạm thời sau N lần đăng nhập thất bại liên tiếp, để chống brute-force mật khẩu trên một tài khoản cụ thể.

#### Acceptance Criteria

1. WHEN một POST tới `/api/v1/auth/login` nhận credentials không hợp lệ, THE Login_Guard SHALL ghi Login_Attempt với `result='fail'`, `reason='invalid_credentials'` và tăng `userFailedCount` cho `email` trong cửa sổ `lockoutWindowSeconds` gần nhất.
2. WHEN `userFailedCount` cho một email đạt `userMaxFailedAttempts` trong cửa sổ trượt, THE Login_Guard SHALL set `userLockedUntil = now() + userLockoutDurationSeconds` cho user đó.
3. WHILE `userLockedUntil > now()`, THE Login_Guard SHALL trả HTTP 423 với body `{ errors: [{ code: 'ACCOUNT_LOCKED', retryAfterSeconds: <int> }] }` cho mọi attempt đến email đó, kể cả khi credentials đúng.
4. WHEN một POST `/api/v1/auth/login` thành công với credentials hợp lệ AND user không bị lock AND toàn bộ login flow (bao gồm phát hành JWT response) hoàn tất thành công, THE Login_Guard SHALL reset `userFailedCount` về 0 và xoá `userLockedUntil`. WHEN credentials hợp lệ nhưng login flow thất bại ở bước sau (ví dụ JWT signing lỗi), THE Login_Guard SHALL không reset failed count.
5. THE Login_Guard SHALL trả cùng body và cùng latency profile cho `INVALID_CREDENTIALS` của email tồn tại và email không tồn tại trong DB (chống user enumeration).
6. THE Login_Guard SHALL exposes endpoint authenticated `POST /api/v1/admin/security/unlock-user` cho phép admin đã đăng nhập gỡ lock một email cụ thể.
7. THE Login_Guard SHALL cảnh báo khi Bootstrap_Admin email là email duy nhất và đang bị lock (single point of failure) qua một banner trong response của health endpoint admin.

### Requirement 8: Rate limit theo IP

**User Story:** Là chủ instance, tôi muốn chặn IP gửi quá nhiều request login thất bại, để chống brute-force credential stuffing trên nhiều tài khoản khác nhau từ cùng một IP.

#### Acceptance Criteria

1. WHEN một POST `/api/v1/auth/login` đến từ IP `X` nhận credentials không hợp lệ, THE Login_Guard SHALL tăng `ipFailedCount[X]` trong cửa sổ trượt `lockoutWindowSeconds`.
2. WHEN `ipFailedCount[X]` đạt `ipMaxFailedAttempts` trong cửa sổ trượt AND `ipMaxFailedAttempts ≥ 3` (sàn cứng để chặn block do typo đơn lẻ), THE Login_Guard SHALL set `ipBlockedUntil[X] = now() + ipLockoutDurationSeconds`. THE Setup_Wizard SHALL enforce `ipMaxFailedAttempts ≥ 3` ở Requirement 6 validation.
3. WHILE `ipBlockedUntil[X] > now()`, THE Login_Guard SHALL trả HTTP 429 với header `Retry-After: <seconds>` cho mọi POST `/api/v1/auth/login` từ IP `X`, không phân biệt email.
4. THE Login_Guard SHALL trích IP từ header `CF-Connecting-IP` nếu có (Cloudflare); fallback về header `X-Forwarded-For` (lấy IP đầu tiên) nếu request đi qua proxy được khai báo trong env `LUMIBASE_TRUSTED_PROXIES`; fallback cuối cùng về địa chỉ remote của TCP connection.
5. WHERE request đến từ IP loopback (`127.0.0.1`, `::1`) AND `LUMIBASE_DEV_AUTH=true`, THE Login_Guard SHALL bỏ qua đếm IP để không cản trở development.
6. THE Login_Guard SHALL áp dụng IP rate limit độc lập với user lockout — một IP có thể bị block ngay cả khi chưa user nào bị lock.
7. THE Login_Guard SHALL exposes endpoint authenticated `POST /api/v1/admin/security/unblock-ip` cho admin gỡ block một IP.

### Requirement 9: Phát hiện anomaly theo địa lý

**User Story:** Là admin, tôi muốn được cảnh báo hoặc bị yêu cầu xác minh thêm khi đăng nhập từ một quốc gia chưa từng thấy trên tài khoản của tôi, để bị compromise credential ở vùng địa lý khác bị phát hiện sớm.

#### Acceptance Criteria

1. WHILE `geoAnomalyEnabled=true` AND có GeoIP lookup khả dụng, WHEN một login attempt thành công với credentials hợp lệ, THE Anomaly_Detector SHALL resolve country code (ISO-3166 alpha-2) từ IP của request.
2. WHEN country code của attempt không nằm trong Login_Baseline.countries của user đó AND user đã có ≥ 3 successful login lịch sử, THE Anomaly_Detector SHALL gán `geoAnomalySubscore = 1.0` cho attempt đó.
3. WHEN country code đã có trong Login_Baseline.countries, THE Anomaly_Detector SHALL gán `geoAnomalySubscore = 0.0`.
4. WHEN user có < 3 successful login lịch sử (chưa đủ baseline), THE Anomaly_Detector SHALL gán `geoAnomalySubscore = 0.0` và đánh dấu attempt là `baselineWarmup=true`.
5. WHEN GeoIP lookup thất bại hoặc IP là private/loopback, THE Anomaly_Detector SHALL gán `geoAnomalySubscore = 0.0` và set `geoLookupStatus='unavailable'` trên Login_Attempt.
6. THE Anomaly_Detector SHALL update Login_Baseline.countries cho user mỗi khi login thành công, thêm country code mới của attempt vào danh sách (nếu chưa có).

### Requirement 10: Phát hiện anomaly theo thời gian

**User Story:** Là admin, tôi muốn được cảnh báo khi có người đăng nhập thành công vào giờ rất khác giờ tôi thường đăng nhập, để dấu hiệu compromise được phát hiện sớm.

#### Acceptance Criteria

1. WHILE `timeAnomalyEnabled=true`, WHEN một successful login attempt xảy ra cho user có ≥ 10 successful login lịch sử, THE Anomaly_Detector SHALL tính phân phối tần suất login theo giờ (0–23) trong múi giờ UTC qua Login_Baseline.hourHistogram cho attempt đó (tính lazy, chỉ trong context của login event).
2. WHEN một successful login attempt xảy ra với giờ `h` (UTC) sao cho `Login_Baseline.hourHistogram[h] / totalLogins < 0.02`, THE Anomaly_Detector SHALL gán `timeAnomalySubscore = 1.0` cho attempt đó.
3. WHEN một successful login attempt xảy ra với giờ `h` có tỷ lệ ≥ 0.02, THE Anomaly_Detector SHALL gán `timeAnomalySubscore = 0.0` cho attempt đó.
4. WHEN user có < 10 successful login lịch sử, THE Anomaly_Detector SHALL gán `timeAnomalySubscore = 0.0` và đánh dấu `baselineWarmup=true`.
5. THE Anomaly_Detector SHALL update Login_Baseline.hourHistogram cho user sau mỗi successful login (tăng `hourHistogram[hour(now)]` lên 1).

### Requirement 11: Phát hiện anomaly theo thiết bị / User-Agent

**User Story:** Là admin, tôi muốn được cảnh báo khi tài khoản của tôi đăng nhập thành công từ một thiết bị (User-Agent) hoàn toàn mới, để phát hiện token/credential leak sang máy khác.

#### Acceptance Criteria

1. WHILE `deviceAnomalyEnabled=true`, WHEN một login attempt thành công, THE Anomaly_Detector SHALL tính `deviceFingerprint = sha256(normalize(userAgent) || acceptLanguage || screen-class-derived-from-UA)` và truncate 16 ký tự hex đầu.
2. WHEN `deviceFingerprint` không nằm trong Login_Baseline.deviceFingerprints của user AND user đã có ≥ 3 successful login lịch sử, THE Anomaly_Detector SHALL gán `deviceAnomalySubscore = 1.0`.
3. WHEN `deviceFingerprint` đã có trong Login_Baseline.deviceFingerprints, THE Anomaly_Detector SHALL gán `deviceAnomalySubscore = 0.0`.
4. WHEN user có < 3 successful login lịch sử, THE Anomaly_Detector SHALL gán `deviceAnomalySubscore = 0.0` và `baselineWarmup=true`.
5. THE Login_Baseline.deviceFingerprints SHALL giới hạn ≤ 20 fingerprint per user, evict theo LRU khi vượt.
6. THE Anomaly_Detector SHALL update Login_Baseline.deviceFingerprints cho user sau mỗi successful login.

### Requirement 12: Tổng hợp Anomaly Score và Anomaly Action

**User Story:** Là admin, tôi muốn các tín hiệu anomaly được tổng hợp thành một score duy nhất với hành động tương ứng, để chính sách bảo mật rõ ràng và có thể tinh chỉnh được.

#### Acceptance Criteria

1. THE Anomaly_Detector SHALL tính `anomalyScore = max(geoAnomalySubscore, timeAnomalySubscore, deviceAnomalySubscore)` cho mỗi successful login attempt.
2. WHEN `anomalyScore ≥ anomalyScoreThreshold` AND `anomalyAction='notify_only'`, THE Login_Guard SHALL cho phép login thành công, ghi Login_Attempt với `anomalyTriggered=true` và đẩy notification (Requirement 13).
3. WHEN `anomalyScore ≥ anomalyScoreThreshold` AND `anomalyAction='lock'`, THE Login_Guard SHALL từ chối login với HTTP 423 body `{ errors: [{ code: 'ANOMALY_LOCK', recoveryHint: 'Check email for recovery link.' }] }`, set `userLockedUntil = now() + userLockoutDurationSeconds`, và đẩy notification.
4. WHEN `anomalyScore ≥ anomalyScoreThreshold` AND `anomalyAction='require_mfa'`, THE Login_Guard SHALL trả HTTP 401 với body `{ errors: [{ code: 'MFA_REQUIRED' }] }`. Note: `'require_mfa'` chỉ available khi MFA module được cài; ở giai đoạn này MFA chưa có nên Setup_Wizard SHALL disable lựa chọn này.
5. WHEN `baselineWarmup=true` cho attempt, THE Login_Guard SHALL bỏ qua check ở (2)–(4) bất kể `anomalyScore`, vì baseline chưa đủ tin cậy. WHILE `baselineWarmup=true`, THE Login_Guard SHALL bỏ qua mọi anomaly check kể cả `'require_mfa'` (MFA-by-anomaly không được trigger trong giai đoạn warmup); MFA bắt buộc cho mọi login (không phụ thuộc anomaly) nằm ngoài phạm vi spec này.

### Requirement 13: Notification khi lockout / anomaly trigger

**User Story:** Là admin, tôi muốn nhận thông báo qua email hoặc webhook ngay khi tài khoản của mình bị lock hoặc có login anomaly, để phản ứng kịp thời.

#### Acceptance Criteria

1. WHEN một event thuộc tập `{user_locked, ip_blocked, anomaly_triggered, anomaly_lock}` xảy ra, THE Login_Guard SHALL gửi notification đồng thời tới mọi Notification_Channel trong `Lockout_Policy.notifyChannels`.
2. WHERE Notification_Channel chứa `'email'` AND email server được cấu hình (env `LUMIBASE_SMTP_URL` hoặc tương đương), THE Login_Guard SHALL gửi email tới Bootstrap_Admin (và tới user bị ảnh hưởng nếu khác Bootstrap_Admin) với subject chứa event code và body chứa: thời gian (ISO 8601 UTC), email user bị ảnh hưởng, IP, country, User-Agent, anomalyScore, link recovery (nếu có).
3. WHERE Notification_Channel chứa `'webhook'` AND `Lockout_Policy.webhookUrl` đã set, THE Login_Guard SHALL POST JSON `{ event, timestamp, email, ip, country, userAgent, anomalyScore, action }` tới webhookUrl với HMAC-SHA256 signature trong header `X-Lumibase-Signature`.
4. WHEN gửi notification thất bại, THE Login_Guard SHALL không block login attempt ngay cả với event nghiêm trọng (`user_locked`, `anomaly_lock`); lỗi gửi notification SHALL được ghi vào Audit_Log với `event='notification_delivery_failed'` và sẽ retry tối đa 3 lần với exponential backoff.
5. THE Login_Guard SHALL rate-limit notification cùng `(event, email)` xuống tối đa 1 notification mỗi 60 giây để tránh notification spam khi attacker liên tục trigger.

### Requirement 14: Recovery khi tài khoản bị khoá hoặc Admin Path bị mất

**User Story:** Là admin bị lock chính tài khoản của mình hoặc làm mất Admin_Path, tôi muốn có cách phục hồi mà không cần truy cập database trực tiếp, để không phải re-deploy instance.

#### Acceptance Criteria

1. THE Setup_Wizard SHALL có bước cuối "Recovery Setup" hiển thị 8 Backup_Code dạng `XXXX-XXXX` (mỗi code 8 ký tự alphanumeric, sinh từ CSPRNG).
2. THE Setup_Service SHALL hash Backup_Code bằng PBKDF2-SHA256 (cùng scheme với password) và lưu hash vào bảng `admin_backup_codes` với cờ `used_at` ban đầu là NULL.
3. THE Setup_Wizard SHALL yêu cầu người dùng tick xác nhận "I have saved these backup codes" trước khi cho hoàn tất setup; nếu không tick, "Finish setup" bị disable.
4. THE CMS SHALL exposes endpoint không-cần-auth `POST /api/v1/admin/security/recover` nhận body `{ email, backupCode }` và:
   - WHEN email khớp Bootstrap_Admin AND backupCode hash khớp một row có `used_at IS NULL`, THE Recovery_Service SHALL set `used_at=now()` cho row đó, gỡ user lockout, gỡ IP block của IP request, và trả lại `{ adminPath, oneTimeUnlockToken }`.
   - WHEN email không khớp HOẶC backupCode hash không khớp, THE Recovery_Service SHALL trả HTTP 401 sau delay ngẫu nhiên 200–500ms.
5. THE CMS SHALL exposes endpoint không-cần-auth `POST /api/v1/admin/security/forgot-path` nhận body `{ email }` và:
   - WHEN email khớp Bootstrap_Admin AND email server được cấu hình, THE Recovery_Service SHALL gửi Recovery_Token tới email đó.
   - WHEN email không khớp, THE Recovery_Service SHALL trả HTTP 200 generic (chống enumeration) mà không gửi gì.
6. THE Recovery_Token SHALL hết hạn sau 30 phút và chỉ dùng được một lần.
7. THE Recovery_Service SHALL áp dụng rate limit 3 request / IP / giờ cho cả `/recover` và `/forgot-path` để chống brute-force backup code.
8. WHEN Bootstrap_Admin reset Admin_Path qua flow recovery, THE Recovery_Service SHALL invalidate mọi Recovery_Token và session đang active của user đó **chỉ sau khi** Admin_Path mới đã commit thành công vào DB. IF Admin_Path reset thất bại ở bất kỳ bước nào (validation, DB write, post-commit cache invalidation), THEN THE Recovery_Service SHALL roll back toàn bộ thay đổi (Admin_Path, session invalidation, token invalidation) về trạng thái trước recovery để giữ tính nhất quán.

### Requirement 15: Audit Log cho Setup và sự kiện bảo mật

**User Story:** Là admin, tôi muốn xem được lịch sử mọi sự kiện liên quan setup và login security, để điều tra sự cố và đáp ứng yêu cầu compliance.

#### Acceptance Criteria

1. THE CMS SHALL ghi Audit_Log entry cho mỗi event thuộc tập: `setup_started`, `setup_completed`, `bootstrap_admin_created`, `admin_path_set`, `lockout_policy_updated`, `login_success`, `login_failed`, `user_locked`, `user_unlocked`, `ip_blocked`, `ip_unblocked`, `anomaly_triggered`, `recovery_initiated`, `recovery_completed`, `backup_code_used`.
2. THE Audit_Log entry SHALL chứa: `id`, `timestamp`, `event`, `actorEmail` (nullable), `targetEmail` (nullable), `ip`, `userAgent`, `country`, `metadata` (JSON), `requestId`.
3. THE CMS SHALL không ghi password, hash mật khẩu, raw Setup_Token, raw Backup_Code, hoặc Recovery_Token vào Audit_Log; các giá trị nhạy cảm SHALL được mask hoặc thay bằng SHA-256 hex 8 ký tự đầu.
4. THE CMS SHALL exposes endpoint authenticated admin-only `GET /api/v1/admin/security/audit-log` trả paginated list (cursor-based) với filter theo `event`, `email`, `from`, `to`.
5. WHEN Audit_Log table chứa > 10,000 row, THE CMS SHALL không từ chối ghi mới mà rotate row cũ nhất theo retention policy `LUMIBASE_AUDIT_RETENTION_DAYS` (mặc định 90 ngày).
6. THE CMS SHALL exposes endpoint authenticated admin-only `GET /api/v1/admin/security/audit-log/export` trả NDJSON tải xuống cho compliance export.

### Requirement 16: Round-trip serialization cho Lockout Policy

**User Story:** Là một developer, tôi muốn Lockout_Policy được lưu/đọc bằng JSON một cách an toàn, để cấu hình export/import qua admin backup không corrupt data.

#### Acceptance Criteria

1. THE Setup_Service SHALL có hàm `serializeLockoutPolicy(policy: LockoutPolicy): string` chuyển object thành JSON canonical (key sorted, no extra whitespace).
2. THE Setup_Service SHALL có hàm `parseLockoutPolicy(json: string): LockoutPolicy | ValidationError` validate kết quả parse theo schema Zod khớp Requirement 6.
3. FOR ALL hợp lệ `policy: LockoutPolicy`, `parseLockoutPolicy(serializeLockoutPolicy(policy))` SHALL trả lại object deep-equal với `policy` ban đầu (round-trip property).
4. WHEN `parseLockoutPolicy` nhận JSON với field thiếu, THE Setup_Service SHALL điền giá trị mặc định preset "Standard" cho field thiếu thay vì reject (forward compatibility).
5. WHEN `parseLockoutPolicy` nhận JSON với field thừa, THE Setup_Service SHALL bỏ qua field thừa và log warning một lần per startup.
6. WHEN `parseLockoutPolicy` nhận JSON với field sai kiểu hoặc ngoài range, THE Setup_Service SHALL trả `ValidationError` với danh sách field lỗi.

### Requirement 17: Setup Impact Registry — giữ setup đồng bộ với tính năng mới

**User Story:** Là một maintainer, tôi muốn có một nơi duy nhất theo dõi việc setup wizard có khởi tạo đầy đủ trạng thái mà các tính năng mới yêu cầu hay không, để setup không bị tụt hậu âm thầm qua các phiên bản.

#### Acceptance Criteria

1. THE spec admin-setup-wizard SHALL duy trì file `setup-impact.md` (Setup Impact Registry) là nguồn sự thật duy nhất về các yêu cầu khởi tạo phát sinh từ feature khác.
2. WHEN một feature spec mới hoàn thành, THE feature đó SHALL được rà soát theo 6 câu hỏi trong `setup-impact.md` và ghi kết quả vào bảng Registry (kể cả khi kết quả là `n/a`), theo DoD chung tại `.kiro/steering/definition-of-done.md`.
3. WHEN Registry có entry `pending`, THE entry SHALL có task tương ứng trong `tasks.md` (Phase G trở đi) trước khi được triển khai.
4. WHEN một entry chuyển sang `done`, THE thay đổi SHALL bao gồm: cập nhật setup transaction, backfill idempotent cho instance đã khởi tạo (nếu cần), và cập nhật docs (`docs/en/agent-setup/prompt.md`, CHANGELOG upgrade steps).
