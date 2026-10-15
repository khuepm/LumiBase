---
version: 4
sourceLang: en
lastUpdated: 2026-10-15T17:00:42.580Z
translatedFrom: en
sourceHash: c95fceb2497cf0a4
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-10-15T17:00:42.580Z
codeVerifiedHash: c95fceb2497cf0a4
codeVerifiedClaims: 22
---

# Kiểm tra bản nháp trong Studio

Trình soạn thảo mục nội dung có panel **Kiểm tra bản nháp**. Panel chạy một trong các hồ sơ kiểm tra của site (các endpoint `/api/v1/ai/review-profiles` và `/api/v1/ai/reviews` trong [AI Copilot](../api/hono-api-spec.md#8-ai-copilot)) trên nội dung đang soạn và liệt kê một gợi ý cho mỗi câu hỏi của hồ sơ. Kiểm tra chỉ gợi ý: nó không bao giờ lưu, xuất bản hay thay đổi một mục trên server.

Code: `apps/studio/src/modules/content/draft-review-panel.tsx`, `apps/studio/src/modules/content/use-draft-review.ts`, `apps/studio/src/modules/content/draft-review-hash.ts`.

## Panel xuất hiện ở đâu

- **Mục đã lưu** (`item-detail.tsx`): panel nằm ở cột bên. Khi các trường được kiểm tra chưa đổi, CMS kiểm tra chính mục đã lưu (`itemId`), đọc nó theo quyền của bạn và ghi lại revision mới nhất. Khi bạn có thay đổi chưa lưu ở các trường đó, panel kiểm tra các giá trị chưa lưu.
- **Mục mới** (`item-create.tsx`): panel kiểm tra form chưa lưu. Chỉ những trường của hồ sơ mà bạn vừa được đọc vừa được tạo mới được gửi đi; panel cho biết trường nào không được kiểm tra.

Panel liệt kê các hồ sơ đang hoạt động của bộ sưu tập. Khi có nhiều hơn một hồ sơ, bạn chọn hồ sơ bằng một ô chọn.

Panel chỉ hiện khi bộ sưu tập đang nằm trong pilot kiểm tra bản nháp ở chế độ `assisted` (`GET /api/v1/ai/reviews/rollout`). Ở chế độ `baseline`, khi pilot tắt, hoặc khi không đọc được chế độ (ví dụ thiếu `ai:decide`), trình soạn thảo không có panel và hoạt động như trước. Site admin bật tắt ở **Settings → AI decisions**; xem [Pilot kiểm tra bản nháp](./jev-draft-review-pilot.md).

## Gợi ý và thao tác

Mỗi gợi ý hiển thị câu hỏi, câu trả lời và chính phần mô tả tiêu chí của hồ sơ:

- **choice**: lựa chọn được gợi ý kèm xác suất và độ tin cậy, cộng các lựa chọn có khả năng cao nhất. `unknown` hiển thị là "Chưa đủ thông tin" và `other` là "Không chuyên mục nào phù hợp".
- **score**: mức có khả năng cao nhất và xác suất của từng mức.
- **noul**: có hoặc không kèm xác suất.

Nhà cung cấp và model được hiển thị kèm nhãn **Đã hiệu chỉnh (theo nhà cung cấp)** hoặc **Chưa hiệu chỉnh**. Jev không trả về lập luận, nên panel không hiển thị lý giải hay trích dẫn nào.

Mỗi gợi ý có ba thao tác. Mỗi thao tác ghi một phán quyết cho mỗi lượt chạy và câu hỏi qua `POST /api/v1/ai/reviews/:id/feedback`:

| Thao tác | Phản hồi | Thay đổi form |
|---|---|---|
| Chấp nhận | `accept` | Chỉ với câu hỏi `choice` có key là một trường của bộ sưu tập: đặt trường đó thành lựa chọn được gợi ý |
| Sửa | `edit` kèm giá trị của bạn | Cùng quy tắc: đặt trường đó thành giá trị bạn chọn |
| Từ chối | `reject` | Không bao giờ |

Giá trị chỉ được áp dụng sau khi CMS đã lưu phản hồi. Áp dụng chỉ thay đổi bản nháp trong trình soạn thảo, không gì khác. Bạn giữ kết quả bằng nút **Save** quen thuộc, và xuất bản vẫn cần các thao tác biên tập cùng quyền của chúng.

Gợi ý cho một trường **đã ghim**, hoặc cho trường bạn không được ghi, được hiển thị ở chế độ chỉ đọc: Chấp nhận và Sửa bị vô hiệu hoá, Từ chối vẫn dùng được. Câu hỏi score và noul không bao giờ thay đổi trường; Chấp nhận và Sửa của chúng chỉ ghi nhận phản hồi.

## Kết quả lỗi thời

Khi một lượt kiểm tra bắt đầu, panel giữ JSON chuẩn hoá của nội dung được kiểm tra (đúng dạng CMS dùng để băm). Nếu nội dung đó thay đổi trước hoặc sau khi câu trả lời về, kết quả trở thành **lỗi thời**: Chấp nhận và Sửa bị vô hiệu hoá và nút đổi thành **Chạy lại**. Lỗi 409 `REVIEW_STALE` từ CMS (ví dụ sau khi người khác đã lưu mục) dẫn tới cùng trạng thái. Kết quả lỗi thời không bao giờ ghi đè chỉnh sửa mới hơn.

Với bản nháp chưa lưu, phản hồi kèm mã băm của bản nháp như bạn đang thấy, để CMS có thể từ chối một phán quyết về nội dung đã thay đổi.

## Trạng thái

| Trạng thái | Khi nào |
|---|---|
| Chưa thiết lập | bộ sưu tập không có hồ sơ đang hoạt động, `REVIEW_PROFILE_NOT_FOUND`, hoặc `DECISION_NOT_CONFIGURED` |
| Đang tắt | `DECISION_DISABLED` cho site |
| Không có quyền | `FORBIDDEN` (thiếu capability `ai:decide`) |
| Hết ngân sách | `DECISION_QUOTA_EXCEEDED`, `DECISION_CONCURRENCY_LIMITED` hoặc `DECISION_RATE_LIMITED`, kèm thời gian chờ `Retry-After` khi có |
| Quá thời gian | `DECISION_TIMEOUT` |
| Nhà cung cấp không khả dụng | `DECISION_UNAVAILABLE`, `DECISION_UPSTREAM`, `DECISION_AUTH`, `DECISION_PARSE_FAILED`, `DECISION_VALIDATION` hoặc `DECISION_QUOTA_UNAVAILABLE` |
| Chưa đủ thông tin | lượt chạy là `abstained`: gợi ý vẫn hiển thị, Chấp nhận một giá trị trường bị vô hiệu hoá, Sửa vẫn dùng được |

Mọi lỗi đều nói rõ chưa có gì được kiểm tra. Không lỗi nào được hiển thị như một lần đạt. **Huỷ kiểm tra** huỷ request, và rời trình soạn thảo cũng huỷ nó.

## Đa tenant và quyền

- **Cô lập theo tenant:** hồ sơ, lượt chạy và phản hồi. Mọi lời gọi mang site đang hoạt động trong `X-Lumi-Site`, và CMS giới hạn đọc ghi theo `site_id`.
- **Dùng chung:** không có gì mới. Khoá nhà cung cấp nằm trên CMS; Studio không bao giờ thấy nó.
- Kiểm tra mục chạy theo quyền dòng và quyền trường của chính người gọi. Kiểm tra snapshot chỉ gửi các trường người gọi được đọc và ghi.
- Được kiểm chứng bởi `apps/studio/src/modules/content/__tests__/draft-review-panel.test.tsx` (luồng trình soạn thảo, race lỗi thời, trường chỉ đọc và đã ghim, người kiểm tra không có quyền ghi, huỷ, các trạng thái lỗi, tiếng Việt) và các test route của CMS trong `apps/cms/src/routes/__tests__/ai-review.test.ts` (kiểm tra chéo site và quyền).

## Shell desktop và mobile

Các lời gọi đi qua `getApiClient()`, nên dùng `getApiBaseUrl()` và token store (keychain của hệ điều hành trong shell). `apps/studio/src/lib/__tests__/draft-review-api.test.tsx` kiểm tra base URL, bearer và header site với một CMS origin chọn lúc chạy.

## Ngôn ngữ

Nội dung chữ của panel đi kèm trong `apps/studio/src/locales/en/content.json` và `apps/studio/src/locales/vi/content.json` và theo ngôn ngữ i18next đang hoạt động.

Studio chọn ngôn ngữ sau khi đăng nhập (`apps/studio/src/components/site-language.tsx`, `apps/studio/src/lib/ui-language.ts`):

1. tuỳ chọn của chính bạn, key `language` của `GET /api/v1/me/preferences`;
2. nếu không có, ngôn ngữ mặc định của site (Settings → Site, `defaultLanguage`);
3. nếu không có nữa, tiếng Anh.

Chỉ có tiếng Anh (`en`) và tiếng Việt (`vi`); tag theo vùng như `vi-VN` sẽ chọn `vi`, còn ngôn ngữ khác thì chuyển sang nguồn kế tiếp. Studio không dùng ngôn ngữ của trình duyệt. Trước khi đăng nhập, Studio hiển thị tiếng Anh. Phần lớn các trang Studio khác chưa được dịch nên vẫn hiện tiếng Anh dù chọn ngôn ngữ nào.
