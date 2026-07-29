---
version: 1
lastUpdated: 2026-07-28T10:23:38.100Z
sourceLang: en
translatedFrom: en
sourceHash: 6566a4891f71eb1a
mtEngine: claude
syncStatus: machine-translated
---

# AIO (AI Overviews Optimization) — LumiBase

Tài liệu theo dõi các cải tiến AIO cho lumibase.dev và docs.lumibase.dev, cùng kế hoạch cho một module đánh giá AIO tích hợp sẵn.

---

## Version 1 — Quick Wins (XONG, 2026-06-10)

Toàn bộ thay đổi nằm trong `apps/landing`:

| Sửa | File | Trạng thái |
|---|---|---|
| JSON-LD Organization + WebSite (mọi trang) | `src/app/layout.tsx` | ✅ Xong |
| JSON-LD SoftwareApplication (trang chủ) | `src/app/page.tsx` | ✅ Xong |
| JSON-LD FAQPage + BreadcrumbList (pricing) | `src/app/pricing/page.tsx` | ✅ Xong |
| `metadataBase` + canonical URL (cả 5 trang) | layout + từng `page.tsx` | ✅ Xong |
| og:image (1200×630, sinh lúc build) | `src/app/opengraph-image.tsx` | ✅ Xong |
| `/llms.txt` cho lumibase.dev | `public/llms.txt` | ✅ Xong |
| Sitemap: thêm `/pricing/`, ngày lastmod thật | `src/app/sitemap.ts` | ✅ Xong |
| Bỏ tuyên bố sai "Join thousands of developers" | trang home + pricing | ✅ Xong |
| Thêm mục answer-target "What is LumiBase?" | `src/app/page.tsx` | ✅ Xong |

### KHÔNG sửa được trong repo này — cần hành động thủ công

#### 1. robots.txt chặn AI crawler (NGHIÊM TRỌNG)

File `apps/landing/public/robots.txt` trong repo là sạch (`Allow: /` cho tất cả). Các block AI-crawler thấy trên site live (GPTBot, ClaudeBot, Google-Extended, CCBot, v.v. đều `Disallow: /`) được **tính năng managed robots.txt của Cloudflare** chèn vào.

**Cách sửa:** Cloudflare Dashboard → chọn zone `lumibase.dev` → **Settings** (hoặc **Security → Bots**, tuỳ UI theo plan) → tìm **"Manage AI bots"** / **"robots.txt management"** → rồi chọn một trong hai:
- Tắt hẳn managed robots.txt (file trong repo sẽ được phục vụ nguyên trạng), hoặc
- Đổi policy từ "Block on all pages" sang "Only block for AI training" — cách này giữ `Content-Signal: ai-train=no` mà vẫn cho phép crawler AI search/retrieval.

**Ghi chú quyết định:** Bỏ chặn nghĩa là các hệ thống AI (ChatGPT, Claude, Perplexity, Gemini) có thể đọc và dẫn nguồn site. Content signal `ai-train=no` vẫn thể hiện việc opt-out khỏi training theo EU Directive 2019/790 Điều 4 cho các crawler tuân thủ, nhưng nó là một tín hiệu thể hiện mong muốn, không phải cơ chế cưỡng chế.

#### 2. Metadata của GitHub repository

- ~~Commit một file `LICENSE` vào gốc repo~~ — **đã xong**; `LICENSE` ở gốc đã được track.
- ⚠️ **Sai lệch về danh tính license (còn mở).** File `LICENSE` đã commit là
  **Apache License 2.0**, và cả bốn package được publish (`sdk`, `mcp-server`,
  `extension-sdk`, `create-lumibase`) đều khai `"license": "Apache-2.0"`. Nhưng
  nội dung trên landing site, báo cáo audit AIO, và bản nháp Devpost đều nói
  **MIT**. Một trong hai phía là sai, và đây là một tuyên bố pháp lý, không phải
  chuyện chọn từ ngữ — hãy quyết định license nào là đúng ý, rồi làm cho nội dung
  site, các trường `package.json` và `LICENSE` khớp nhau. Các hệ thống AI đọc
  license từ repo, nên sai lệch cũng làm mất chính cái tín hiệu tin cậy mà mục
  này định sửa.
- Thêm topic: `headless-cms`, `cloudflare-workers`, `edge`, `typescript`, `cms`, `open-source`.
- Đặt trường Homepage thành `https://lumibase.dev`.

---

## Version 1.5 — Các mục audit còn lại (TODO)

- [ ] Chuyển `apps/docs` (Vite SPA) sang SSR/static HTML — docs.lumibase.dev hiện trả về một shell 558 byte cho crawler. Phương án: pre-render bằng `vite-plugin-ssr`/`vike`, hoặc chuyển sang VitePress/Starlight vì chúng dùng chính markdown trong `/docs`.
- [ ] Trang About trên lumibase.dev kèm tên tác giả + thông tin chuyên môn.
- [ ] Email liên hệ trong Privacy Policy và ToS (hiện chỉ dẫn về GitHub — khoảng trống theo GDPR Điều 12).
- [ ] Trang `/changelog` công khai phơi CHANGELOG.md ra.
- [ ] Sửa "Last updated: {build date}" ở trang tos/privacy — hiện đang là `new Date()` lúc build, tức làm giả độ mới. Hãy dùng ngày nội dung thực sự đổi.
- [ ] Tín hiệu cộng đồng: bài Show HN, ra mắt Product Hunt, gửi vào list awesome-cloudflare, bài Dev.to. (Brand Authority 8/100 — chỉ sửa được qua sự hiện diện cộng đồng trong nhiều tháng, không phải bằng code.)

---

## Version 2 — Module đánh giá AIO tích hợp sẵn (KẾ HOẠCH)

**Mục tiêu:** Một năng lực tự audit AIO bên trong LumiBase, để mọi project chạy LumiBase có thể tự cho điểm nội dung của mình về độ hiện diện trong AI search — không cần công cụ bên ngoài.

### Vì sao nó phù hợp với LumiBase

LumiBase là một CMS — nó sở hữu nội dung, phần render, và cả việc deploy. Nghĩa là nó có thể đánh giá các tín hiệu AIO ngay tại nguồn (trước khi publish) thay vì phải crawl sau khi đã xuất bản như các công cụ bên ngoài buộc phải làm.

### Kiến trúc đề xuất (theo đúng quy ước module hiện có)

```
apps/cms/src/modules/aio/
  index.ts              ← đăng ký module
  service.ts            ← GeoAuditService (business logic)
  routes.ts             ← GET /api/aio/audit, GET /api/aio/score/:itemId
  checks/
    citability.ts       ← cho điểm ở mức đoạn văn (answer block, mật độ Q&A, số liệu)
    schema.ts           ← sự hiện diện/tính hợp lệ của JSON-LD theo từng content type
    meta.ts             ← độ đầy đủ của title/description/canonical/OG
    crawlers.ts         ← validate robots.txt + llms.txt cho domain của tenant
    freshness.ts        ← tính nhất quán của lastmod, nội dung có ghi ngày
  scoring.ts            ← điểm tổng hợp có trọng số (trọng số cấu hình được)

packages/ai-skills/src/skills/
  geo-audit.ts          ← skill của AI Copilot: "audit item/site này về AIO" (read-only, không cần HITL)
  geo-fix.ts            ← skill của AI Copilot: "sinh schema/meta còn thiếu" (schema:write → cần HITL phê duyệt)
```

### Quy tắc thiết kế (theo quy ước dự án)

1. Multi-tenant: mọi row audit đều có `site_id`; kết quả lưu theo từng tenant.
2. IDs: `nanoid()` cho bảng domain `geo_audits`; `uuidv7()` nếu thêm một bảng audit log.
3. Trừu tượng runtime: fetch URL bên ngoài (robots.txt của domain tenant) qua `c.get('runtime')` — không dùng CF binding trực tiếp.
4. Định dạng response: `{ data: { score, categories, findings } }`.
5. Bài học từ lần audit skill bên ngoài (2026-06-10):
   - Không bao giờ báo "missing" cho thứ mà fetcher không thể thấy — phải phân biệt **đã xác nhận vắng mặt** với **không quan sát được** (bug WebFetch cắt `<head>` đã tạo ra 2 finding sai).
   - Điểm số là heuristic — hãy lưu version của bộ rule cùng mỗi điểm để so sánh delta được.
   - Các kiểm tra sự thật (có schema không? có canonical không?) thuộc về code tất định; chỉ phần cho điểm citability/chất lượng mới cần LLM.

### Mô hình cho điểm (trọng số ban đầu, cấu hình được theo từng site)

| Hạng mục | Trọng số | Cách triển khai |
|---|---|---|
| Citability | 25% | Heuristic tất định + một lượt LLM tuỳ chọn |
| Schema & structured data | 20% | Tất định (parse + validate JSON-LD) |
| Độ đầy đủ của meta | 20% | Tất định |
| Truy cập của crawler (robots/llms.txt) | 20% | Tất định (kiểm tra HTTP) |
| Freshness | 15% | Tất định (lastmod so với lần nội dung cập nhật) |

Brand Authority bị **loại** khỏi điểm trong sản phẩm — nó cần quét các nền tảng bên ngoài (Reddit/HN/Wikipedia), bị rate-limit, và không hành động được từ bên trong CMS.

### Các giai đoạn giao hàng

- **Phase A (MVP):** chỉ các kiểm tra tất định — `GET /api/aio/audit` trả về điểm + finding cho site đã publish của tenant. Không LLM, không thêm dependency.
- **Phase B:** panel UI trong Studio (badge điểm cho từng item của collection, dashboard ở cấp site).
- **Phase C:** skill của AI Copilot (`geo-audit` read-only; `geo-fix` cần HITL phê duyệt cho các lần ghi schema).
- **Phase D:** audit theo lịch qua CDC/cron + theo dõi delta (dùng lại ý tưởng `geo-compare`).

---

*Cập nhật lần cuối: 2026-06-10*
