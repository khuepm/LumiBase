---
version: 3
lastUpdated: 2026-07-29T05:26:14.674Z
sourceLang: en
translatedFrom: en
sourceHash: 0434e76bd6629620
mtEngine: claude
syncStatus: machine-translated
---

# Báo cáo audit AIO: LumiBase

**Ngày audit:** 2026-06-10
**URL:** https://lumibase.dev
**Loại hình:** SaaS — Headless CMS Edge-Native
**Số trang đã phân tích:** 5 (/, /pricing, /tos, /privacy, /license)
**Site docs:** docs.lumibase.dev (SPA JavaScript — không crawl được)

---

> **📌 ẢNH CHỤP LỊCH SỬ — đừng đọc các phát hiện bên dưới như trạng thái hiện tại.**
> Báo cáo này mô tả lumibase.dev như nó đã ở vào ngày **2026-06-10**. Phần lớn đã
> được sửa từ đó. Đã kiểm chứng với `apps/landing` tại thời điểm viết ghi chú này:
> JSON-LD giờ đã có ở layout, trang chủ và trang pricing (C2, H3, L1);
> `public/llms.txt` đã tồn tại (H1); `/pricing` đã có trong `sitemap.ts` (H4);
> tuyên bố "Join thousands of developers" đã bị bỏ (H6); `metadataBase`/canonical
> đã được đặt (M5); `opengraph-image.tsx` sinh ảnh OG (H2); và một file `LICENSE`
> đã được commit ở gốc repo (M3). Lưu ý license được trích dẫn xuyên suốt báo cáo
> này là **MIT** vì đó là điều site nói ở thời điểm 2026-06-10; project đã đổi sang
> **Apache-2.0** ở `v0.23.0` và nội dung site đã được cập nhật cho khớp, nên mọi
> chỗ nhắc MIT bên dưới là mốc cơ sở *trước* khi đổi license, không phải tuyên bố
> hiện hành.
> **Vẫn còn mở:** C1 (các block AI-crawler do managed robots.txt của Cloudflare
> chèn vào, không phải do file trong repo) và C3 (`apps/docs` vẫn là một SPA Vite).
> Về trạng thái sống, hãy đọc [`aio/README.md`](./README.md) — file này được giữ
> lại như mốc cơ sở mà các điểm số đã được đo dựa trên.
>
> **⚠️ ĐÍNH CHÍNH (2026-06-10, đã verify bằng curl trên HTML thô):** Hai phát hiện trong báo cáo này là SAI, do một giới hạn của tool WebFetch (nó cắt bỏ nội dung `<head>`):
> - **C4 "Không có meta description" là SAI** — mọi trang đều có meta description.
> - **H2 "Thiếu tag OG/Twitter" là PHẦN LỚN SAI** — các tag OG và Twitter Card đều có; chỉ thiếu `og:image`.
>
> Các phát hiện đã được xác nhận là ĐÚNG: robots.txt chặn AI crawler (do Cloudflare quản lý), không có JSON-LD schema nào, không có canonical tag, llms.txt trả 404 trên lumibase.dev, /pricing thiếu trong sitemap, docs là SPA (response 558 byte). Các điểm số là heuristic, không phải một chuẩn của ngành — hãy chỉ coi chúng là metric theo dõi tương đối.

## Tóm tắt điều hành

**Điểm AIO tổng thể: 24/100 — Critical**

LumiBase là một sản phẩm vững về kỹ thuật với chiều sâu engineering thực sự, nhưng sự hiện diện web công khai của nó gần như hoàn toàn vô hình với các hệ thống AI search. Site có ba vấn đề cộng dồn: (1) robots.txt chặn tường minh mọi AI crawler lớn, gồm GPTBot, ClaudeBot, Google-Extended, và CCBot; (2) không có schema markup nào ở bất cứ đâu trên site; và (3) site docs — nơi chứa phần thực chất về kỹ thuật — là một SPA phía client mà không AI crawler nào đọc được. Chỉ ba vấn đề này thôi đã đủ giữ mọi điểm AIO ở mức Critical bất kể chất lượng nội dung. Sản phẩm được làm tốt; website thì đang chủ động chống lại việc nó được các hệ thống AI phát hiện hay dẫn nguồn.

### Phân rã điểm

| Hạng mục | Điểm | Trọng số | Điểm có trọng số |
|---|---|---|---|
| AI Citability | 22/100 | 25% | 5.5 |
| Brand Authority | 8/100 | 20% | 1.6 |
| Content E-E-A-T | 34/100 | 20% | 6.8 |
| Technical AIO | 49/100 | 15% | 7.35 |
| Schema & Structured Data | 4/100 | 10% | 0.4 |
| Platform Optimization | 19/100 | 10% | 1.9 |
| **Điểm AIO tổng thể** | | | **24/100** |

### Cách hiểu điểm

| Khoảng | Xếp loại |
|---|---|
| 90-100 | Excellent |
| 75-89 | Good |
| 60-74 | Fair |
| 40-59 | Poor |
| **0-39** | **Critical ← LumiBase đang ở đây** |

---

## Vấn đề Critical (sửa ngay)

### C1 — Mọi AI crawler lớn bị chặn trong robots.txt

**Ảnh hưởng:** Mọi nền tảng AI search — ChatGPT, Claude, Perplexity, Gemini, Apple Intelligence — bị ngăn về mặt cấu trúc, không thể index hay dẫn nguồn lumibase.dev trong thời gian thực.

File robots.txt (do block "Managed Content" của Cloudflare quản lý) disallow tường minh:

| Crawler | Chủ sở hữu | Nền tảng bị ảnh hưởng |
|---|---|---|
| GPTBot | OpenAI | ChatGPT Search, training của OpenAI |
| ClaudeBot | Anthropic | Việc dẫn nguồn của Claude |
| Google-Extended | Google | Gemini, Google AI Overviews |
| CCBot | Common Crawl | Nhiều LLM mã nguồn mở |
| Amazonbot | Amazon | Alexa, Rufus AI |
| Bytespider | ByteDance | Doubao AI |
| Applebot-Extended | Apple | Apple Intelligence |
| meta-externalagent | Meta | Meta AI, Llama |

Ý định có vẻ là chặn **AI training** (directive `Content-Signal: ai-train=no` diễn đạt đúng điều đó). Tuy nhiên các rule `Disallow: /` lại chặn **mọi hoạt động của AI bot**, bao gồm cả việc truy xuất cho search thời gian thực và grounding để dẫn nguồn — những việc không liên quan tới training. Kết quả là không AI assistant nào có thể đưa lumibase.dev ra khi người dùng hỏi về các lựa chọn edge CMS, dù site có nội dung xuất sắc đến đâu.

**Cách sửa:** Bỏ các block `Disallow: /` có tên cho GPTBot, ClaudeBot, Google-Extended, PerplexityBot, và CCBot. Giữ `ai-train=no` trong directive Content-Signal để bảo toàn việc opt-out khỏi training. Việc cấm training và việc cho phép truy xuất cho search là hai điều độc lập; robots.txt hiện tại đang gộp chúng lại.

```
# REPLACE THIS (current — blocks all AI bots):
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

# WITH THIS (allow retrieval, maintain training opt-out via Content-Signal):
# [remove GPTBot and ClaudeBot blocks entirely]
# The Content-Signal: ai-train=no line already handles training exclusion
```

Cũng hãy thêm `ai-input=yes` vào Content-Signal để cho phép tường minh việc AI grounding/RAG:
```
Content-Signal: search=yes,ai-train=no,ai-input=yes
```

---

### C2 — Không có schema markup nào trên bất kỳ trang nào

**Ảnh hưởng:** Các model AI không thể thực hiện entity resolution cho LumiBase. Không có schema Organization + SoftwareApplication, sẽ không có tín hiệu máy đọc được nào nối lumibase.dev với repository GitHub, profile Twitter, hay hạng mục sản phẩm của nó. Với mọi knowledge graph của AI, site này thực chất là một tài liệu HTML vô danh.

**Các trang đã kiểm tra:** /, /pricing, /tos, /privacy — không tìm thấy JSON-LD, Microdata, hay RDFa nào trên bất kỳ trang nào.

**Cách sửa (mức tối thiểu khả dụng):** Thêm vào `<head>` của mọi trang (layout toàn cục):

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "LumiBase",
  "url": "https://lumibase.dev",
  "description": "Edge-native headless CMS built on Cloudflare Workers. Open-source, privacy-first, and globally distributed by default.",
  "sameAs": [
    "https://github.com/khuepm/lumibase",
    "https://twitter.com/lumibase"
  ]
}
```

Chỉ thêm vào `<head>` của trang chủ:

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "LumiBase",
  "url": "https://lumibase.dev",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cloudflare Workers, Docker, Node.js",
  "description": "Edge-native headless CMS built on Cloudflare Workers. Deploy globally, manage content via REST API, and scale to zero with no cold starts.",
  "softwareVersion": "0.4.5",
  "codeRepository": "https://github.com/khuepm/lumibase",
  "license": "https://lumibase.dev/license",
  "isAccessibleForFree": true,
  "offers": [
    {
      "@type": "Offer",
      "name": "Community",
      "price": "0",
      "priceCurrency": "USD",
      "url": "https://lumibase.dev/pricing"
    },
    {
      "@type": "Offer",
      "name": "Hobby",
      "price": "29",
      "priceCurrency": "USD",
      "billingIncrement": "P1M",
      "url": "https://lumibase.dev/pricing"
    },
    {
      "@type": "Offer",
      "name": "Enterprise",
      "price": "99",
      "priceCurrency": "USD",
      "billingIncrement": "P1M",
      "url": "https://lumibase.dev/pricing"
    }
  ]
}
```

---

### C3 — Site docs là một SPA JavaScript (vô hình với mọi AI crawler)

**Ảnh hưởng:** docs.lumibase.dev chỉ trả về `<title>LumiBase Docs</title>` cho các HTTP fetcher. Mọi AI crawler, mọi search bot, mọi hệ thống dẫn nguồn khi fetch URL này qua HTTP đều không nhận được nội dung có nghĩa nào. Toàn bộ kho tài liệu kỹ thuật — API reference, data model, các quyết định kiến trúc, AI skills — bị mắc kẹt sau JavaScript phía client.

Với một tool cho developer, tài liệu là loại nội dung có giá trị cao nhất để AI dẫn nguồn. Đó là nơi người dùng đặt các câu hỏi "làm X thế nào" mà AI assistant trả lời. Việc docs là một SPA nghĩa là LumiBase không thể được dẫn nguồn cho bất kỳ câu hỏi how-to kỹ thuật nào.

**Cách sửa:** Chuyển docs.lumibase.dev sang HTML render ở server hoặc sinh tĩnh. Hệ sinh thái Cloudflare/Vite có các lựa chọn hạng nhất:
- [VitePress](https://vitepress.dev/) — static site generator thiết kế cho docs, tích hợp trực tiếp với Cloudflare Pages
- [Starlight](https://starlight.astro.build/) — framework docs dựa trên Astro, hỗ trợ SSR và có adapter cho Cloudflare Pages

---

### C4 — Không có meta description trên bất kỳ trang nào

**Ảnh hưởng:** Cả năm nền tảng AI search (Google AI Overviews, ChatGPT, Perplexity, Gemini, Bing Copilot) đều dùng meta description làm bản tóm tắt chuẩn của trang, để sinh snippet, làm ngữ cảnh dẫn nguồn, và làm nguồn cho câu trả lời. Không có chúng, các nền tảng AI tự sinh snippet — với lumibase.dev, việc này có nguy cơ sinh ra "Built with ❤ by Khuepm © 2026 LumiBase" làm description.

**Cách sửa (mọi trang):**

- **Trang chủ:** `"Open-source headless CMS built on Cloudflare Workers. Edge-native performance, global CDN, privacy-first, and free forever under MIT license."`
- **Pricing:** `"Simple, transparent pricing. Community (free forever), Hobby ($29/mo), Enterprise ($99/mo). Open-source core always free under MIT license."`
- **ToS:** `"LumiBase Terms of Service — usage terms for LumiBase software and managed hosting services."`
- **Privacy:** `"LumiBase Privacy Policy — data handling, retention, and your rights under GDPR and CCPA."`

---

## Vấn đề mức High

### H1 — Không có file llms.txt

`https://lumibase.dev/llms.txt` trả về HTTP 404. Chuẩn llms.txt cung cấp cho các model AI một chỉ mục có cấu trúc về nội dung site — đặc biệt quan trọng ở đây vì site docs là một SPA. Không có llms.txt, các hệ thống AI không thể phát hiện API reference, data model, hay tài liệu kiến trúc.

**`/llms.txt` được khuyến nghị:**

```markdown
# LumiBase

> Edge-native headless CMS built for modern web development. Open-source (MIT), deployed on Cloudflare Workers, privacy-first.

## Documentation

- [Getting Started](https://docs.lumibase.dev/getting-started): Quick setup guide for self-hosting LumiBase on Cloudflare Workers or Docker.
- [API Reference](https://docs.lumibase.dev/api): Full REST API specification for content items, collections, and tenants.
- [Data Model](https://docs.lumibase.dev/data-model): Schema definitions and multi-tenant architecture overview.
- [AI Skills](https://docs.lumibase.dev/ai-skills): AI Copilot skill registry and HITL approval flow documentation.

## Product

- [Homepage](https://lumibase.dev): Product overview and feature summary.
- [Pricing](https://lumibase.dev/pricing): Community (free), Hobby ($29/mo), Enterprise ($99/mo) tiers with feature comparison.
- [GitHub Repository](https://github.com/khuepm/lumibase): Source code, issues, and contribution guide.

## Legal

- [Terms of Service](https://lumibase.dev/tos): Usage terms.
- [Privacy Policy](https://lumibase.dev/privacy): Data handling and privacy commitments.
- [License](https://lumibase.dev/license): MIT License terms.
```

---

### H2 — Thiếu tag Open Graph và Twitter Card (mọi trang)

Không phát hiện tag OG hay Twitter Card nào ở bất cứ đâu. Mọi lần chia sẻ link tới lumibase.dev — Slack, Discord, Twitter/X, LinkedIn — đều hiện ra một card trống. Đây là bề mặt chia sẻ xã hội chính của các tool cho developer.

**Thêm vào `<head>` của trang chủ:**

```html
<meta property="og:type" content="website" />
<meta property="og:site_name" content="LumiBase" />
<meta property="og:title" content="LumiBase - Edge-Native Headless CMS" />
<meta property="og:description" content="Open-source headless CMS built on Cloudflare Workers. Edge-native performance, global CDN, privacy-first, and free forever under MIT license." />
<meta property="og:url" content="https://lumibase.dev" />
<meta property="og:image" content="https://lumibase.dev/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@lumibase" />
<meta name="twitter:title" content="LumiBase - Edge-Native Headless CMS" />
<meta name="twitter:description" content="Open-source headless CMS built on Cloudflare Workers. Edge-native performance, global CDN, privacy-first, and free forever under MIT license." />
<meta name="twitter:image" content="https://lumibase.dev/og-image.png" />
```

Cũng hãy tạo một `og-image.png` (1200×630px) — không có asset ảnh này, các tag OG sẽ tạo ra preview bị vỡ.

---

### H3 — Thiếu schema FAQPage trên /pricing

Trang pricing đã có 5 cặp Q&A FAQ được viết tốt. Thêm schema FAQPage mất khoảng 10 phút và là hành động schema có ROI cao nhất đang khả dụng — các model AI (ChatGPT, Claude, Perplexity) chủ động parse markup FAQPage để làm bản tóm tắt dẫn nguồn.

**Thêm vào `<head>` của `/pricing`:**

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What's the difference between self-hosted and managed?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Self-hosted means you deploy LumiBase on your own infrastructure (free). Managed means we host it for you with automatic updates, backups, and support (paid tiers)."
      }
    },
    {
      "@type": "Question",
      "name": "Can I switch plans anytime?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes. You can upgrade or downgrade your plan at any time. Changes take effect immediately and we'll prorate the difference."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need to pay for the open-source version?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. The core LumiBase is and will always be free and open-source under the MIT license. Premium features are optional."
      }
    },
    {
      "@type": "Question",
      "name": "How does GitHub Sponsors work?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "When you sponsor us on GitHub, you'll get access to premium features based on your sponsorship tier. We'll send you a reward token to unlock features."
      }
    },
    {
      "@type": "Question",
      "name": "What payment methods do you accept?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "We accept GitHub Sponsors (credit card, PayPal), and for Enterprise plans we also accept wire transfers and invoices."
      }
    }
  ]
}
```

---

### H4 — /pricing không có trong sitemap.xml

Sitemap chỉ liệt kê 4 URL (/, /tos, /privacy, /license). Trang pricing — nội dung có cấu trúc dễ dẫn nguồn nhất trên site — thì vắng mặt. Các AI crawler dùng sitemap để phát hiện nội dung sẽ bỏ lỡ nó.

**Cách sửa:** Thêm vào sitemap.xml:
```xml
<url>
  <loc>https://lumibase.dev/pricing/</loc>
  <lastmod>2026-06-07T12:57:03.987Z</lastmod>
  <changefreq>monthly</changefreq>
  <priority>0.8</priority>
</url>
```

---

### H5 — Không có trang About, không có thông tin chuyên môn của tác giả

Toàn bộ site không có trang About, không có trang Team, và không có một người nào được nêu tên kèm thông tin chuyên môn kiểm chứng được. Ghi nhận duy nhất là "Built with ❤ by Khuepm" ở footer — không có họ tên đầy đủ, không LinkedIn, không link profile GitHub, không thông tin chuyên môn.

Với việc đánh giá E-E-A-T của AI, việc không có tác giả nhận diện được là một điểm trừ đáng kể về Expertise và Authoritativeness.

**Cách sửa:** Tạo `/about` gồm: họ tên đầy đủ, kinh nghiệm về Cloudflare/edge computing, link profile GitHub, và điều gì làm bạn đủ năng lực để xây một CMS chạy production. Không cần dài — 3-4 đoạn.

---

### H6 — "Join thousands of developers" là tuyên bố kiểm chứng được là sai

Repository GitHub cho thấy: 1 star, 0 fork, 1 contributor. Tuyên bố "Join thousands of developers building fast, modern content experiences" có thể bị bác bỏ trực tiếp bởi bất kỳ hệ thống AI hay quality rater nào có quyền truy cập GitHub API. Đây là tín hiệu tin cậy gây thiệt hại nhất trên site.

**Cách sửa:** Bỏ ngay. Thay bằng một badge GitHub star (hiện số thật) hoặc đơn giản là bỏ tuyên bố social proof đó cho tới khi thực sự đạt được.

---

### H7 — Thiếu security header

Các security header sau vắng mặt trong HTTP response:
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy` (CSP)
- `X-Frame-Options`
- `Permissions-Policy`

Chúng có thể được đặt qua Cloudflare Transform Rules hoặc trong middleware response của Workers, không cần đổi code ứng dụng.

---

## Vấn đề mức Medium

### M1 — Chiều sâu nội dung: 280 từ trên trang chủ

Trang chủ khoảng ~280 từ. Để các hệ thống AI dẫn nguồn một trang cho các truy vấn như "edge-native headless CMS là gì" hay "CMS tốt nhất cho Cloudflare Workers", trang cần nội dung answer-target thực chất — thường là 800–1.500 từ kèm các mục Q&A có cấu trúc.

**Các bổ sung được khuyến nghị:**
- Mục "What is LumiBase?" (một đoạn trả lời trực tiếp khoảng 50 từ)
- Mục so sánh "How is LumiBase different from Directus / Contentful?"
- Ít nhất một benchmark hoặc số liệu hiệu năng cụ thể để chống lưng cho tuyên bố "sub-millisecond response times"

---

### M2 — Không có lần nhắc thương hiệu nào trên các nền tảng mà AI tham chiếu

LumiBase không có sự hiện diện trên:
- Reddit (r/webdev, r/cms, r/cloudflare)
- Hacker News (không có bài Show HN)
- Product Hunt (không có listing)
- Dev.to / Hashnode / Medium (không có bài viết)
- YouTube (không có video)
- Bất kỳ danh sách so sánh "best headless CMS" nào

Việc được nhắc tới trên các nền tảng này mạnh hơn backlink 3× đối với việc AI nhận diện thực thể (Ahrefs, 12/2025). Một bài Show HN hoặc một bài Dev.to được đón nhận tốt sẽ tạo ra tín hiệu thực thể bên ngoài đầu tiên.

**Các hành động được khuyến nghị (theo thứ tự ưu tiên):**
1. Đăng "Show HN: LumiBase — Edge-native headless CMS on Cloudflare Workers" trên Hacker News
2. Ra mắt trên Product Hunt
3. Gửi vào danh sách GitHub `awesome-cloudflare`
4. Viết một bài kỹ thuật trên Dev.to về các quyết định kiến trúc (multi-tenancy, HITL AI approval, các pattern edge caching)

---

### M3 — Repository GitHub thiếu topic và metadata license

Metadata của repo GitHub hiện `license: None` dù MIT được nhắc tới trên site. Chưa đặt topic nào. Đây là các tín hiệu chất lượng cho tập dữ liệu training của AI.

> **Mục này đã lỗi thời theo cách nó được viết.** File `LICENSE` giờ đã có ở gốc
> repo và là **Apache-2.0**, không phải MIT — việc đổi license được ghi trong
> `CHANGELOG.md` ở mục `[0.23.0]`. Nội dung site đã được cập nhật cho khớp. Hãy
> đọc phần "Cách sửa" bên dưới theo nghĩa "commit `LICENSE` để GitHub hiện đúng
> license"; chỗ nhắc MIT là trạng thái *trước* khi đổi license mà báo cáo này ghi
> lại, không phải mục tiêu cần đạt.

**Cách sửa:**
- Commit một file `LICENSE` vào gốc repository (GitHub khi đó sẽ hiện đúng license)
- Thêm topic: `headless-cms`, `cloudflare-workers`, `edge`, `typescript`, `cms`, `open-source`
- Điền trường Homepage trong settings của repo bằng `https://lumibase.dev`

---

### M4 — Timestamp lastmod giống nhau ở mọi entry của sitemap

Cả 4 entry trong sitemap dùng cùng một timestamp chính xác (2026-06-07T12:57:03.985Z / .987Z). Cái này trông như được sinh bằng chương trình, không phản ánh các lần nội dung thực sự đổi. Các search engine dùng lastmod để lập lịch crawl; timestamp giống nhau làm giảm hiệu quả của việc lập lịch.

---

### M5 — Không có canonical tag

Không phát hiện `<link rel="canonical">` trên bất kỳ trang nào. Trang `/pricing` có một redirect 308 từ `/pricing` → `/pricing/`, nghĩa là có hai URL cho cùng nội dung mà không có canonical để phân định.

---

### M6 — Khoảng trống thông tin liên hệ ở site docs

Cả Privacy Policy và Terms of Service đều dẫn mọi liên hệ về "repository GitHub". Để tuân thủ GDPR Điều 12 và để bên mua doanh nghiệp tin tưởng ở mức cơ bản, cần có một địa chỉ email riêng. Hãy tạo `hello@lumibase.dev` và thêm nó vào cả hai trang pháp lý.

---

## Vấn đề mức Low

### L1 — Không có schema WebSite + SearchAction

Thêm schema `WebSite` kèm một `SearchAction` trỏ tới `docs.lumibase.dev` sẽ mở khả năng đủ điều kiện cho sitelinks search box và báo hiệu site docs là knowledge base chuẩn.

### L2 — Không có schema BreadcrumbList ở các trang bên trong

Một bổ sung ít công sức, cho các trang bên trong `/pricing`, `/tos`, `/privacy` có ngữ cảnh điều hướng trong SERP.

### L3 — Cache edge của Cloudflare chưa bật cho các trang tĩnh

`CF-Cache-Status: DYNAMIC` trên mọi response nghĩa là mỗi request đều chạy toàn bộ Worker. Với một site marketing tĩnh, đặt `Cache-Control: public, s-maxage=86400` qua Transform Rules sẽ cải thiện hiệu năng cho các lần ghé lại trên toàn cầu.

### L4 — Chưa triển khai IndexNow (Bing)

IndexNow là một protocol của Bing/Yandex, thông báo tức thì cho index khi nội dung đổi. Triển khai mất khoảng ~30 phút và cải thiện tín hiệu độ mới cho Bing Copilot.

### L5 — Không có trang Changelog

`CHANGELOG.md` tồn tại trên GitHub nhưng không được phơi ra trên lumibase.dev. Một trang `/changelog` công khai cung cấp tín hiệu về độ mới của nội dung và cho thấy dự án đang được phát triển tích cực, với cả người dùng lẫn hệ thống AI.

---

## Đi sâu theo hạng mục

### AI Citability — 22/100

Không khối nội dung nào trên site vượt ngưỡng 70 điểm "sẵn sàng để dẫn nguồn" mà các model AI dùng để trích dẫn. Khối tốt nhất là bảng pricing (57/100) — dữ liệu dạng bảng có cấu trúc, kèm các mức giá cụ thể. Tệ nhất là headline H1 ("Build Content Management At the Edge") ở 20/100 — một lời kêu gọi hành động dạng mệnh lệnh, không phải một phát biểu mang thông tin.

Khoảng trống then chốt: không có pattern "answer target" nào. Một answer target là một heading dạng câu hỏi (H2: "What is LumiBase?") theo sau là một đoạn trả lời trực tiếp 40–60 từ. Pattern này là tín hiệu chính mà các model AI dùng để nhận ra nội dung dẫn nguồn được cho các truy vấn định nghĩa. Toàn bộ trang chủ không có heading nào dạng câu hỏi.

Các tuyên bố "sub-millisecond response times" và "300+ edge locations" vay số liệu hạ tầng của Cloudflare mà LumiBase không sở hữu chúng như số liệu gốc của mình. Các model dẫn nguồn AI trừ điểm cho số liệu đi vay.

**Điểm citability theo từng khối:**

| Khối nội dung | Điểm | Đánh giá |
|---|---|---|
| Bảng pricing (tier + tính năng) | 57/100 | Tốt nhất trên site — có cấu trúc, cụ thể |
| FAQ pricing (self-hosted vs managed) | 52/100 | Pattern Q-A tốt, nhưng không có schema |
| Khối tính năng "Global CDN" | 44/100 | Số liệu đi vay (300+ PoP của Cloudflare) |
| Tính năng "Edge-Native Performance" | 43/100 | Tuyên bố cụ thể về nền tảng, ở mức biên |
| Tagline chính | 30/100 | Copy SaaS chung chung |
| Headline H1 | 20/100 | Mệnh lệnh, không có giá trị thông tin |

---

### Brand Authority — 8/100

LumiBase không tồn tại như một thực thể được nhận diện trong bất kỳ corpus training AI hiện tại nào. Repository GitHub được tạo ngày 2026-05-13 (28 ngày trước lần audit này). Với 1 star, 0 fork, và không có lần dẫn nguồn bên ngoài nào, thương hiệu không có tín hiệu authority nào để khiến một model AI khuyến nghị nó khi được hỏi về headless CMS.

**Bản đồ hiện diện theo nền tảng:**

| Nền tảng | Trạng thái | Ghi chú |
|---|---|---|
| Wikipedia | Vắng mặt | Không có bài, không có thực thể |
| Reddit | Vắng mặt | Không lần nhắc nào trên mọi subreddit liên quan |
| YouTube | Vắng mặt | Không có video |
| LinkedIn | Vắng mặt | Không có trang công ty |
| Product Hunt | Vắng mặt | Không có listing |
| Hacker News | Vắng mặt | Không có Show HN, không có submission |
| Dev.to / Hashnode | Vắng mặt | Không có bài viết |
| G2 / Capterra | Vắng mặt | Không có listing |
| GitHub | Tối thiểu | 1 star, 0 fork, 1 contributor |
| Twitter/X | Chưa xác nhận | Handle @lumibase đã được nhận; hoạt động chưa xác nhận |

Sản phẩm khoảng 28 ngày tuổi tại thời điểm audit. Điều này là bình thường với một sản phẩm mới. Con đường từ đây là xây dựng cộng đồng, không phải sửa kỹ thuật.

---

### Content E-E-A-T — 34/100

| Chiều | Điểm | Phát hiện chính |
|---|---|---|
| Experience | 5/25 | Không demo, không case study, không benchmark, không ví dụ thực tế |
| Expertise | 9/25 | Tác giả "Khuepm" — không họ tên đầy đủ, không thông tin chuyên môn, không trang bio |
| Authoritativeness | 9/25 | 1 GitHub star, không có lần dẫn nguồn bên ngoài, không hiện diện trong ngành |
| Trustworthiness | 14/25 | Có HTTPS + các trang pháp lý, nhưng không có email liên hệ và có một tuyên bố sai "thousands of developers" |

Phần thực chất về kỹ thuật của LumiBase — được ghi trong `CLAUDE.md`, README trên GitHub, và các architecture decision record — cho thấy năng lực engineering thật. Không thứ nào trong đó nhìn thấy được với các hệ thống AI truy cập website công khai. README bàn về các chọn lựa kiến trúc thực sự (NanoID vs UUIDv7, cách ly multi-tenancy, luồng HITL approval). Bề mặt website thì là một tờ rơi marketing 280 từ, không chia sẻ gì trong số đó.

---

### Technical AIO — 49/100

**Điểm cộng:** Site dùng SSR (HTML đầy đủ trong response đầu tiên), phục vụ qua HTTP/2 từ mạng edge của Cloudflare (nhanh trên toàn cầu), có cấu trúc URL gọn, và HTTPS được bắt buộc. Nền kỹ thuật cơ bản là vững.

**Điểm trừ:** robots.txt chặn AI crawler (Critical), thiếu meta description (Critical), thiếu tag OG/Twitter (High), không có llms.txt (High), /pricing vắng trong sitemap (High), thiếu các security header HSTS/CSP/X-Frame-Options (High), không có canonical tag (Medium), cache edge của Cloudflare chưa bật cho trang tĩnh (Low).

---

### Schema & Structured Data — 4/100

Không có structured data nào trên bất kỳ trang nào. 4 điểm này chỉ phản ánh việc site đang ở trạng thái sạch (không có schema lỗi thời nào cần bỏ). Mọi schema được ghi trong mục Vấn đề Critical đều có thể làm ngay — không cần đổi gì ở site ngoài việc thêm các khối `<script type="application/ld+json">` vào `<head>` của trang.

**Điểm dự kiến sau khi triển khai bản sửa C2:** 65-70/100 (Organization + SoftwareApplication + FAQPage + WebSite + BreadcrumbList + tag OG/Twitter).

---

### Platform Optimization — 19/100

| Nền tảng | Điểm | Điểm nghẽn |
|---|---|---|
| Google AI Overviews | 22/100 | Google-Extended bị chặn, không schema, nội dung mỏng |
| ChatGPT Web Search | 14/100 | GPTBot bị chặn, không có thực thể Wikipedia |
| Perplexity AI | 16/100 | Không lần nhắc nào từ cộng đồng (Reddit/HN), docs là SPA |
| Google Gemini | 18/100 | Google-Extended bị chặn, không có entry Knowledge Graph |
| Bing Copilot | 26/100 | BingBot KHÔNG bị chặn (chỉ AI crawler bị) — điểm cao nhất |

Bing Copilot là nền tảng duy nhất mà LumiBase tiếp cận được — BingBot được cho phép theo rule wildcard `Allow: /`. Đó là lý do nó có điểm cao nhất: nó là nền tảng duy nhất thực sự crawl được site.

---

## Quick Wins (làm trong tuần này)

5 hành động này có thể hoàn tất trong dưới 4 giờ và sẽ đưa điểm AIO từ 24 lên khoảng 40-45:

1. **Sửa robots.txt — bỏ các block AI crawler** (10 phút) — Bỏ chặn GPTBot, ClaudeBot, Google-Extended, CCBot. Giữ Content-Signal `ai-train=no`. Thêm `ai-input=yes`. Chỉ một thay đổi này thôi đã cho phép mọi nền tảng AI search index site.

2. **Thêm meta description cho mọi trang** (20 phút) — Một dòng cho mỗi trang. Dùng các description ở vấn đề C4 phía trên.

3. **Thêm JSON-LD Organization + SoftwareApplication vào trang chủ** (30 phút) — Copy các khối schema từ vấn đề C2 phía trên vào template HTML của Hono/Workers.

4. **Thêm JSON-LD FAQPage vào /pricing** (15 phút) — Copy khối schema từ vấn đề H3 phía trên. Nội dung Q&A đã có sẵn.

5. **Tạo /llms.txt** (15 phút) — Copy template từ vấn đề H1 phía trên. Phục vụ nó như một file tĩnh từ Cloudflare Workers.

---

## Kế hoạch hành động 30 ngày

### Tuần 1: Bỏ chặn truy cập của AI (sửa kỹ thuật)

- [ ] Sửa robots.txt — bỏ mọi block `Disallow: /` có tên cho AI crawler
- [ ] Thêm `ai-input=yes` vào directive Content-Signal
- [ ] Thêm meta description cho cả 5 trang
- [ ] Thêm JSON-LD Organization + SoftwareApplication vào trang chủ
- [ ] Thêm JSON-LD FAQPage vào /pricing
- [ ] Thêm meta tag Open Graph + Twitter Card cho mọi trang (tạo ảnh OG 1200×630)
- [ ] Tạo /llms.txt
- [ ] Thêm /pricing vào sitemap.xml
- [ ] Thêm `<link rel="canonical">` cho mọi trang
- [ ] Sửa repo GitHub: commit file LICENSE, thêm topic, đặt trường homepage

### Tuần 2: Chiều sâu nội dung

- [ ] Bỏ tuyên bố "Join thousands of developers" (thay bằng badge GitHub star)
- [ ] Thêm mục H2 "What is LumiBase?" vào trang chủ (trả lời trực tiếp 50 từ)
- [ ] Thêm một mục "How LumiBase compares to Directus / Contentful"
- [ ] Tạo trang /about kèm họ tên đầy đủ, thông tin chuyên môn, và kinh nghiệm của tác giả
- [ ] Thêm email liên hệ vào Privacy Policy và Terms of Service
- [ ] Phơi trang /changelog từ CHANGELOG.md trên GitHub

### Tuần 3: Khả năng crawl của docs

- [ ] Chuyển docs.lumibase.dev từ SPA sang SSR/static (VitePress hoặc Starlight)
- [ ] Đảm bảo mọi trang docs đều có trong response HTML đầu tiên
- [ ] Thêm meta description cho mọi trang docs
- [ ] Thêm schema Organization vào site docs

### Tuần 4: Tín hiệu cộng đồng & thương hiệu

- [ ] Đăng "Show HN: LumiBase — Edge-native headless CMS on Cloudflare Workers"
- [ ] Ra mắt trên Product Hunt
- [ ] Gửi vào danh sách GitHub awesome-cloudflare
- [ ] Xuất bản bài kỹ thuật trên Dev.to (các quyết định kiến trúc: multi-tenancy ở edge, HITL AI, deploy Workers)
- [ ] Triển khai IndexNow cho Bing Webmaster Tools
- [ ] Thêm các header HSTS, X-Frame-Options, Permissions-Policy qua Cloudflare Transform Rules

---

## Phụ lục A: Các trang đã phân tích

| URL | Title | Vấn đề tìm thấy |
|---|---|---|
| https://lumibase.dev | LumiBase - Edge-Native Headless CMS | Không meta desc, không schema, không tag OG, ~280 từ |
| https://lumibase.dev/pricing | Pricing - LumiBase | Không meta desc, không schema, không có trong sitemap |
| https://lumibase.dev/tos | (Terms of Service) | Không meta desc, không email liên hệ |
| https://lumibase.dev/privacy | (Privacy Policy) | Không meta desc, không email liên hệ |
| https://lumibase.dev/license | (License) | Chỉ có các vấn đề mức thấp |
| https://docs.lumibase.dev | LumiBase Docs | SPA — chỉ trả về title cho các HTTP fetcher |

---

## Phụ lục B: robots.txt hiện tại so với khuyến nghị

**Hiện tại (chặn AI search):**
```
User-agent: *
Content-Signal: search=yes,ai-train=no
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CloudflareBrowserRenderingCrawler
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: meta-externalagent
Disallow: /

User-agent: *
Allow: /

Sitemap: https://lumibase.dev/sitemap.xml
```

**Khuyến nghị (cho phép AI search, chặn AI training qua Content-Signal):**
```
User-agent: *
Content-Signal: search=yes,ai-train=no,ai-input=yes
Allow: /

# Only block crawlers that serve no search/citation purpose
# and have no compliant ai-input handling:
User-agent: Bytespider
Disallow: /

Sitemap: https://lumibase.dev/sitemap.xml
```

---

## Phụ lục C: Dự phóng điểm sau khi sửa

Nếu mọi vấn đề mức Critical và High được giải quyết trong Tuần 1-2:

| Hạng mục | Hiện tại | Dự phóng | Thay đổi |
|---|---|---|---|
| AI Citability | 22 | 42 | +20 (bỏ chặn crawler + nội dung answer-target) |
| Brand Authority | 8 | 12 | +4 (chỉ sửa metadata GitHub; cộng đồng cần thời gian) |
| Content E-E-A-T | 34 | 48 | +14 (trang About, bỏ tuyên bố sai, email liên hệ) |
| Technical AIO | 49 | 74 | +25 (sửa robots + meta + llms.txt + canonical) |
| Schema & Structured Data | 4 | 68 | +64 (Org + SoftwareApp + FAQPage + tag OG) |
| Platform Optimization | 19 | 38 | +19 (bỏ chặn robots lan toả sang mọi nền tảng) |
| **Điểm AIO tổng thể** | **24** | **~46** | **+22** |

Chỉ riêng các bản sửa Tuần 1-2 đã đưa điểm từ Critical (24) lên Poor (46). Tuần 3-4 (docs SSR + xây cộng đồng) dự phóng lên khoảng 55-62 (Poor → Fair). Việc cải thiện Brand Authority lên Good (75+) cần 6-12 tháng xây dựng hiện diện cộng đồng và không thể tăng tốc chỉ bằng các bản sửa kỹ thuật.

---

*Báo cáo được sinh bởi AIO Audit Skill v1.0 cho lumibase.dev vào 2026-06-10.*
