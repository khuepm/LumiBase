---
version: 2
lastUpdated: 2026-11-18T06:07:15.330Z
sourceLang: en
translatedFrom: en
sourceHash: a0532da35ea57607
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-18T06:07:15.330Z
codeVerifiedHash: a0532da35ea57607
codeVerifiedClaims: 14
---

# Live preview & visual editing

> Trình sửa item của Studio hiển thị frontend thật của bạn cạnh form, cập nhật
> nó khi bạn gõ, tải lại khi bạn lưu, và cho bạn bấm vào một phần tử trên trang
> để nhảy tới field của nó. Epic #667; mô hình bảo mật ở
> [ADR-014](../architecture/decisions/adr-014-preview-bridge-threat-model.md).

**Status:** đã có — preview token (V01), khung preview trong Studio (V02),
overlay `@lumibase/visual-editing` (V03), preview theo version/release/locale
(V04, gồm cả **Preview release** trong Studio), CSP và threat model (V05). Chưa
có: trình dựng trang trực quan (V06, sau v1).

## 1. Các phần ghép với nhau thế nào

```
Studio item editor ──mint──▶ POST /api/v1/preview/token ──▶ { token, url }
      │                                                         │
      │  iframe (sandboxed) ◀──────────── url ───────────────────┘
      ▼
Your frontend /api/preview?token=…  ──server-side──▶ GET /api/v1/deliver/preview/:site_id
      │   (draft mode on, token in an httpOnly cookie)
      ▼
Page rendered from the preview token  ◀──postMessage──▶  Studio (patch / reload / focus)
```

## 2. Bật cho một collection

1. **Data model → (collection) → Display → Preview URL.** Nhập URL của trang
   render một item, kèm placeholder:

   | Placeholder | Giá trị |
   |---|---|
   | `{token}` | preview token (bắt buộc để xem nội dung draft) |
   | `{id}` | id của item |
   | `{slug}` | field `slug` của item, nếu có |
   | `{collection}` | tên collection |
   | `{locale}` | locale preview |
   | `{version}` | key của content version |
   | `{release}` | id của release |

   Ví dụ: `http://localhost:3000/api/preview?token={token}&id={id}`.
   Chỉ nhận URL `http(s)` tuyệt đối (CMS kiểm ở
   `PATCH /api/v1/collections/:name`); mọi giá trị đều được URL-encode.
2. Mở một item và bấm **Preview**. Khung preview mở cạnh form:
   - kéo thanh chia, hoặc focus vào nó rồi dùng ←/→, Home/End, Enter (về mặc định);
   - chọn Desktop / Tablet (768 px) / Mobile (390 px);
   - chỉnh sửa được đẩy sang trang (debounce 150 ms); lưu thì trang tải lại;
   - nếu item có content version, chọn một version ở **Version**: frame hiển
     thị version đó (item liên quan có version cùng key cũng đọc từ version
     đó). Khi đang chọn version, chỉnh sửa chưa lưu trên form không được đẩy
     sang, vì form sửa chính item chứ không phải version.
3. **Preview một release:** Releases (`/releases`, có link từ Content) → (release) → **Preview
   release**. Tuỳ chọn chọn locale, rồi bấm **Create preview link**. Studio mint
   một token gắn với release, và mỗi thành viên có collection đặt Preview URL
   sẽ có link **Open preview** (`{release}` được điền sẵn). Mọi trang mở qua
   link này hiển thị các item của release như khi xuất bản, phần còn lại như
   đang live.

## 3. Settings → Preview

- **Allowed origins** — Studio nhúng origin của chính template. Chỉ thêm origin
  chính xác khác (`https://www.example.com`, không path, không wildcard) nếu
  preview của bạn redirect sang đó. Chỉ site admin.
- **Token lifetime** — 60–3600 s, mặc định 900.
- **Live tokens** — thu hồi từng token, hoặc **Rotate** để thu hồi mọi token
  còn sống của site. Admin thấy mọi token; biên tập viên thấy token của mình.

## 4. Preview token

Token là JWT HS256 gắn site, kèm một dòng phía server (chỉ lưu SHA-256 của
nó). Token đọc bằng quyền của biên tập viên đã mint nó, kiểm lại ở mỗi lần đọc.
Mọi lỗi — sai site, hết hạn, bị thu hồi, người tạo mất quyền — đều trả cùng một
`401`.

```http
POST /api/v1/preview/token
Authorization: Bearer <studio session>

{ "collection": "posts", "itemId": "itm_1", "locale": "vi" }
→ 201 { "data": { "id": "…", "token": "eyJ…", "expiresAt": "…", "url": "https://…" } }
```

Đích là một item (`collection` + `itemId`, tuỳ chọn `versionKey`) hoặc cả một
release (`releaseId`); `locale` được chuyển tới frontend.

| Bạn preview gì | Frontend thấy gì |
|---|---|
| Item | trạng thái hiện tại của item, kể cả draft |
| Item + `versionKey` | dữ liệu của version; **item liên quan có version cùng key cũng đọc từ version đó** |
| Release | mọi thành viên như khi release xuất bản (revision được ghim + status đích); thành viên bị release archive thì ẩn; phần còn lại như đang live |

## 5. Đọc nội dung draft ở frontend

Gửi token trong header `x-lumibase-preview` (hoặc `?__preview=`), từ **server**
của bạn:

```http
GET /api/v1/deliver/preview/:site_id                         # what the token targets (+ the item)
GET /api/v1/deliver/preview/:site_id/items/:collection        # live items + the preview overlay
GET /api/v1/deliver/preview/:site_id/items/:collection/:id    # one item through the overlay
```

Response là `private, no-store` và `noindex`. Xem `examples/nextjs-blog` để có
cấu hình Next.js đầy đủ: `src/app/api/preview/route.ts` kiểm token phía server,
bật draft mode, giữ token trong cookie `httpOnly` rồi redirect;
`src/app/posts/[id]/page.tsx` đọc qua token khi draft mode đang bật.

**Cho phép Studio nhúng site của bạn** — và không ai khác:

```
Content-Security-Policy: frame-ancestors 'self' https://studio.example.com
```

## 6. Overlay click-to-edit (`@lumibase/visual-editing`)

```ts
import { enableVisualEditing, fieldAttributes } from '@lumibase/visual-editing';

const handle = enableVisualEditing({
  studioOrigins: ['https://studio.example.com'], // exact origins, never '*'
  enabled: isDraftMode,
  onPatch: ({ fields }) => { /* optional: re-render changed fields */ },
  onReload: () => router.refresh(),
});

<h1 {...fieldAttributes({ collection: 'posts', itemId: post.id, field: 'title' })}
    data-lumibase-live="text">{post.data.title}</h1>
```

- Rê chuột sẽ vẽ viền; bấm vào sẽ focus field đó trong Studio.
- Phần tử có `data-lumibase-live="text"` cập nhật khi bạn gõ (dạng text, không
  bao giờ là HTML); phần còn lại đi qua `onPatch`/`onReload`.
- Message từ origin hay window khác, lớn hơn 64 KiB, hoặc không khớp schema bị
  bỏ và báo cho `onReject`.
- Không làm gì khi không nằm trong iframe hoặc khi `enabled` là false; ≤ 15 kB gzip.

## 7. Cấu hình cho operator

| Setting | Mặc định | Mục đích |
|---|---|---|
| `JWT_SECRET` | bắt buộc ở production | Khoá preview của site dẫn xuất từ nó; đổi nó làm mất hiệu lực mọi preview token. |
| `LUMIBASE_STUDIO_FRAME_SRC` | `https: http://localhost:* http://127.0.0.1:*` | `frame-src` của HTML Studio do CMS phục vụ. Liệt kê origin chính xác để thu hẹp, hoặc `'none'` để tắt việc nhúng preview. |

Shell desktop/mobile: khung preview chạy được trong shell Tauri; ở chế độ
bundled, origin của Studio là `tauri://localhost`, nên hãy thêm nó vào
`frame-ancestors` của frontend nếu biên tập viên preview từ ứng dụng desktop.
