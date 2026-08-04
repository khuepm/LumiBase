# Giao việc: dịch docs EN⇄VI — LumiBase

> **Ảnh chụp: 2026-08-02, tại `v0.25.0`.** 146 cặp doc — **86 up-to-date, 60 còn việc**
> (53 nhận được ngay, 7 chờ upstream — [§7.5](#75-chờ-upstream--đừng-nhận-bây-giờ)),
> 0 conflict. Con số này lấy từ `pnpm docs:i18n:detect`; chạy lại trước khi bắt đầu vì
> bảng ở [§7](#7-bảng-nhiệm-vụ) là ảnh chụp, còn detect là sự thật.

Tài liệu này là **bản giao việc đầy đủ** cho một agent/LLM nhận dịch. Đọc hết §1–§6
trước khi sửa file đầu tiên. Nó được viết để bạn không cần hỏi ai: mọi quyết định
thường gặp đều đã có câu trả lời ở đây, và những gì bạn **không** được tự quyết đều
được ghi rõ ở [§6](#6-khi-nào-dừng-lại-và-báo-lại).

---

## 1. Bối cảnh bắt buộc phải biết

**Không có machine translation.** Không có `ANTHROPIC_API_KEY`, sẽ không có, và
`sync.mjs --apply` thoát mã 2 nếu bạn thử. Bản dịch do bạn — một LLM đọc trực tiếp
tài liệu nguồn — viết ra. Chi tiết quyết định: [§9](#9-vì-sao-thủ-công).

**Sẽ không có ai review bản dịch của bạn.** Chủ repo đã nói rõ điều này. Không có
người thứ hai đọc lại tiếng Việt hay tiếng Anh bạn viết trước khi nó lên `main` và
ra trang docs công khai. Hệ quả trực tiếp, và là điều quan trọng nhất trong tài liệu
này:

> **Bạn là reviewer của chính mình, và ba script là đồng nghiệp duy nhất của bạn.**
> Chúng không đọc được văn phong, nhưng chúng bắt được đúng những lỗi mà việc không
> có reviewer sẽ để lọt: dịch thiếu một mục, dịch cả tên biến, để nguyên tiếng Anh,
> cắt mất cái bảng cuối file, tự phát minh một đoạn không có trong nguồn.

| Script | Trả lời câu hỏi | Chạy khi nào |
|---|---|---|
| `pnpm docs:i18n:parity <rel>` | Hai bên **có phải cùng một tài liệu** không? (heading, code, link, ngôn ngữ, độ dài) | Sau khi viết bản dịch |
| `pnpm docs:i18n:verify <rel>` | Những gì doc **khẳng định về source code** còn đúng không? | Sau parity, trước stamp |
| `node scripts/docs-i18n/stamp-pair.mjs …` | Ghi provenance. **Tự chạy lại cả hai check trên và từ chối stamp nếu fail.** | Cuối cùng |

`stamp-pair` là cửa cuối. Nó không stamp được thì bản dịch **chưa xong** — đừng
commit rồi tính sau, và đừng dùng `--allow-structure-drift` để đi qua (xem
[§4](#4-khi-checker-từ-chối)).

---

## 2. Quy trình cho MỖI file

Làm đúng thứ tự. Mỗi bước có lý do, không bước nào là hình thức.

### Bước 0 — Xác định chiều dịch, đừng đoán

```bash
pnpm docs:i18n:detect          # → docs/.i18n/last-report.json
```

Tìm `rel` của bạn trong `actions`. Đọc `sourceLocale` / `targetLocale`. **Đây là chiều
dịch, không phải bảng §7** (bảng có thể lệch). Một số doc là **VI-source** với bản EN
là bản dịch — sửa sai chiều là ghi đè lên bản gốc do người viết.

Không bao giờ sửa nội dung phía **nguồn** để làm cho parity xanh. Nguồn là sự thật;
bạn chỉ được sửa nguồn khi chính nó sai về mặt kỹ thuật, và khi đó xem [§6](#6-khi-nào-dừng-lại-và-báo-lại).

### Bước 1 — Đọc nguồn hết một lượt trước khi viết chữ nào

Đọc `docs/<src>/<rel>` từ đầu đến cuối. Nếu file đích đã tồn tại (nhóm B/C), đọc luôn
bản cũ: nó có thể chứa thuật ngữ, cách diễn đạt đã dùng nhất quán ở các file khác —
giữ lại nếu còn đúng. Bạn đang **ghi đè** một bản dịch, không phải tạo mới.

### Bước 2 — Viết bản dịch

Quy tắc, theo mức độ nghiêm ngặt giảm dần:

**Tuyệt đối giữ nguyên, byte-for-byte:**
- Nội dung trong code fence có tag ngôn ngữ (` ```bash `, ` ```ts `, ` ```sql `, ` ```json `…).
  Chỉ **comment** trong đó (`#`, `//`, `--`) được dịch.
- Mọi thứ trong backtick: tên biến, tên hàm, đường dẫn file, tên bảng, env var,
  HTTP method + path, tên lệnh CLI, key YAML/JSON. `LUMIBASE_NEGATIVE_CACHE_TTL`
  không có bản dịch tiếng Việt. `role flags OR active policy flags` nằm trong
  backtick vì nó là biểu thức code — **không** dịch thành `cờ role OR cờ policy`
  (lỗi thật đã từng xảy ra ở `operations/upgrades.md`).
- URL và đích của link. `[text](./features/caching.md)` → dịch `text`, giữ nguyên đường dẫn.
- Cấu trúc markdown: số lượng và cấp heading, số bảng và số dòng mỗi bảng, số item
  mỗi list, số code fence.

**Được dịch:** văn xuôi, tiêu đề, nội dung ô bảng (trừ ô chứa code/identifier),
alt text, label trong sơ đồ ASCII/mermaid, comment trong code fence.

**Giữ tiếng Anh theo quy ước ngành** khi văn viết kỹ thuật tiếng Việt thường giữ:
headless CMS, Edge, runtime, webhook, middleware, cache, endpoint, deploy, rollback,
migration, front matter, placeholder. Đừng dịch cưỡng ép ("phần mềm trung gian").

**Không được làm:**
- Không thêm nội dung không có trong nguồn (không "giải thích thêm cho rõ").
- Không bỏ mục, bỏ ghi chú, bỏ cảnh báo vì thấy dài.
- Không tự sửa số liệu, version, tên file, số port cho "hợp lý hơn".
- Không dịch anchor trong link nội trang thành tiếng Việt rồi để lệch với heading:
  nếu bạn dịch heading, anchor `#…` trong cùng file phải đổi theo cho khớp slug mới.

### Bước 3 — Tự review, trước khi chạy script

Script không đọc được nghĩa. Bạn tự làm việc này, và làm thật:

- [ ] Đọc lại bản dịch **không nhìn nguồn**. Nó có tự đứng được như một tài liệu không?
- [ ] Đối chiếu từng heading với nguồn: đủ, đúng thứ tự, đúng cấp.
- [ ] Mỗi câu khẳng định kỹ thuật ở bản dịch: nó có đúng là điều nguồn nói? Không
      mạnh hơn, không yếu hơn. Đặc biệt các câu có "phải", "không được", "luôn",
      "không bao giờ" — dịch lệch một chữ ở đây là đổi nghĩa vận hành.
- [ ] Con số, version, tên cột, tên constraint: khớp tuyệt đối.
- [ ] Không còn đoạn nào sót lại ở ngôn ngữ nguồn.

### Bước 4 — Ba script, theo đúng thứ tự

```bash
pnpm docs:i18n:parity <rel>     # cấu trúc: heading, code, link, ngôn ngữ, độ dài
pnpm docs:i18n:verify <rel>     # claim về source code còn đúng
node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified
```

`<en|vi>` ở lệnh stamp là **locale nguồn** (bước 0), không phải locale bạn vừa viết.

`--verified` chạy lại `verify` và **từ chối** ghi cờ `codeVerified` nếu còn claim
stale — hoặc nếu doc không có claim nào script kiểm được (`unverifiable`). "Không có
gì để kiểm" **không phải** là pass: khi đó bỏ `--verified`, và nói rõ trong PR rằng
file đó chỉ được người đọc bằng mắt.

### Bước 5 — Xác nhận cặp đã sạch

```bash
pnpm docs:i18n:detect
```

Mở `docs/.i18n/last-report.json`, tìm `rel` của bạn: phải là `"type": "up-to-date"`.
Nếu không, quay lại bước 2 — đừng commit.

### Bước 6 — Dọn artifact máy sinh

```bash
git checkout -- docs/.i18n/last-report.json docs/i18n-sync-log.md
```

Hai file này bị ghi lại mỗi lần chạy detect. **Không commit chúng.** Workflow trên
`main` tự cập nhật. Commit chúng chỉ tạo conflict với các agent khác và với CI.

### Bước 7 — Cập nhật bảng §7 và commit

Đổi `TODO` → `DONE` + ghi tên/id của bạn ở cột Agent, **trong cùng commit với bản dịch**:

```bash
git add docs/en/<rel> docs/vi/<rel> docs/.i18n/TASKS.md
git commit --no-verify -m "docs(i18n): translate <rel> to <VI|EN>"
```

`--no-verify` vì pre-commit hook chạy toàn bộ test suite — chậm và không liên quan
tới thay đổi chỉ đụng `docs/`. Đây là ngoại lệ duy nhất được phép bỏ hook.

---

## 3. Gom lô và mở PR

**Một lô = một PR = một branch mới từ `main`.** Không stack lên PR đã merge, không
thêm commit vào PR của người khác.

```bash
git fetch origin && git checkout -b docs/i18n-batch-<n> origin/main
```

Kích thước lô: **6–10 file hoặc ~500 dòng nguồn**, cái nào tới trước. Lô nhỏ để nếu
có gì sai thì phạm vi sai nhỏ — không có reviewer nên đây là biện pháp giảm thiệt hại
duy nhất còn lại. File > 500 dòng (`api/hono-api-spec.md`, `DEPLOYMENT-CHECKLIST.md`,
`tutorials/nextjs-quickstart.md`) đi **một mình một PR**.

Mỗi file một commit. `git pull --rebase` trước mỗi push. **Không bao giờ `--force`.**

### Thân PR — bắt buộc có, vì nó là thứ duy nhất được đọc

Chủ repo sẽ merge dựa trên thân PR chứ không đọc từng dòng dịch. Viết nó cho đúng việc đó:

```markdown
## Files
| rel | Chiều | Dòng nguồn | parity | verify | stamp |
|---|---|---|---|---|---|
| `features/caching.md` | en→vi | 60 | 0 problems | 4 claims, 0 findings | --verified |

## Output của checker
<dán nguyên output của parity + verify + stamp cho từng file>

## Quyết định dịch cần biết
- Thuật ngữ giữ tiếng Anh: …
- File nào `unverifiable` và vì sao chỉ đọc bằng mắt: …
- Có waiver `check-parity: allow` nào không, ở đâu, vì sao: …

## Tôi KHÔNG làm gì
- Không sửa phía nguồn (hoặc: có, ở file X, vì claim Y đã sai so với code — chi tiết…)
- Không commit `last-report.json` / `i18n-sync-log.md`
```

Đừng tự merge PR. Báo lại và để chủ repo merge.

---

## 4. Khi checker từ chối

| Tình huống | Làm gì |
|---|---|
| `parity` báo `language` | Bản dịch còn ở ngôn ngữ nguồn (hoặc bạn copy nguồn sang). Dịch lại thật. |
| `parity` báo `headings` / `tables` / `code-fences` lệch số lượng | Bạn bỏ sót hoặc nhân đôi một mục. So từng heading với nguồn, tìm chỗ thiếu. |
| `parity` báo `inline-code` | Bạn đã dịch một identifier, hoặc bỏ mất một đoạn có chứa nó. Trả lại đúng token gốc. |
| `parity` báo `links` | Bạn dịch đường dẫn file, hoặc bỏ một cross-reference. Anchor nội trang được phép khác — nhưng **số lượng** phải khớp. |
| `parity` báo `bulk` | Tỉ lệ độ dài lệch quá dải cho phép: gần như luôn là mất phần cuối file. Kiểm tra đoạn cuối. |
| `verify` báo stale claim **ở bản dịch** | Bạn dịch sai tên file/env/route. Sửa lại cho khớp nguồn. |
| `verify` báo stale claim **ở cả hai bên** | Doc đang nói sai về code. Xem [§6](#6-khi-nào-dừng-lại-và-báo-lại) — đừng dịch một điều sai cho đẹp. |
| `verify` báo `unverifiable` | Stamp **không** kèm `--verified`, và ghi vào PR rằng file này chỉ được đọc bằng mắt. |

**`--allow-structure-drift` gần như không bao giờ là câu trả lời.** Nó tồn tại cho
trường hợp lệch có chủ ý thật (ví dụ một bảng chỉ có nghĩa ở một locale). Khi dùng:
đặt waiver ngay trong doc để lý do nằm cạnh chỗ lệch, đừng để nó chỉ nằm trong lệnh:

```markdown
<!-- check-parity: allow tables -->
```

và nói rõ trong PR. Dùng cờ này để "cho xanh" là làm hỏng chính cái gate thay cho reviewer.

---

## 5. Chạy song song nhiều agent

- **Claim trước khi dịch.** `git pull --rebase`, đổi dòng của bạn ở §7 thành
  `CLAIMED` + tên, commit + push ngay (commit chỉ đổi bảng). Agent khác thấy
  `CLAIMED` sẽ bỏ qua.
- **Một file = một unit.** Không hai agent cùng một file. Thấy `CLAIMED`/`DONE` →
  chuyển file khác.
- Conflict chỉ nên xảy ra ở `TASKS.md`. Khi conflict, **giữ cả hai** thay đổi trạng
  thái, merge tay theo dòng.
- Không ai commit `last-report.json` / `i18n-sync-log.md`.

---

## 6. Khi nào DỪNG LẠI và báo lại

Không tự quyết những việc dưới đây. Dừng, mô tả tình huống, hỏi chủ repo:

1. **Hai bên đã trôi độc lập** — cả `docs/en` và `docs/vi` đều có nội dung được viết
   riêng, không bên nào là bản dịch của bên kia. Không có cách máy nào biết bên nào
   đúng. `parity` sẽ báo rất nhiều thứ; đừng "hợp nhất" bằng cách chọn bừa. (Hiện
   detect báo **0 conflict**, nhưng tình huống này sẽ tái xuất khi có người sửa một
   phía.)
2. **Doc nói sai về code** (`verify` báo stale ở cả hai locale). Sửa doc cho khớp code
   là việc đúng, nhưng nó là thay đổi **nội dung**, không phải dịch — và nó cần người
   biết feature đó xác nhận. Báo lại kèm claim cụ thể + chỗ trong code chứng minh.
3. **Nguồn tự mâu thuẫn** hoặc rõ ràng lạc hậu (ví dụ nói về endpoint đã bỏ). Đừng
   dịch trung thành một điều sai, cũng đừng tự viết lại.
4. **Bạn phải sửa phía nguồn** vì bất kỳ lý do gì.
5. **File thuộc surface release** (`api/hono-api-spec.md`, `data-model.md`,
   `agent-setup/prompt.md`, `DEPLOYMENT-CHECKLIST.md`) mà bạn phát hiện nội dung
   không khớp code: đây là mục §5 của `.kiro/steering/v1-release-criteria.md`, ảnh
   hưởng điều kiện tag 1.0.0. Báo ngay, đừng gộp vào commit dịch.

---

## 7. Bảng nhiệm vụ

Ảnh chụp `pnpm docs:i18n:detect` tại 2026-08-02 (`v0.25.0`): 60 file — 53 nhận được
ngay, **7 file đang chờ upstream** ([§7.5](#75-chờ-upstream--đừng-nhận-bây-giờ)). Làm
**từ trên xuống**.

Cột **#** là ID cố định của dòng, **không phải thứ tự** — thứ tự là thứ tự các mục.
ID không đổi khi một dòng được chuyển nhóm, để một file đã `CLAIMED` vẫn tìm lại được.

Cột **parity** = số vấn đề cấu trúc mà cặp đó **đang** có trước khi bạn chạm vào
(`—` = phía đích chưa tồn tại nên không so được). Số càng cao thì bản dịch cũ càng
lệch, và `stamp-pair` sẽ không cho stamp tới khi bạn sửa hết — tính vào công sức.

### Ưu tiên 1 — bản VI thực chất đang là tiếng Anh (3 file)

Người đọc chọn tiếng Việt và nhận về tiếng Anh. Đây là lỗi lộ ra ngoài nặng nhất
trong backlog.

| # | File (rel) | Chiều | Dòng nguồn | parity | Trạng thái | Agent |
|---|---|---|---|---|---|---|
| 1 | `roadmap/phase-d1-users.md` | en→vi | 21 | 3 | DONE | claude-code |
| 2 | `architecture/page-hydration.md` | en→vi | 68 | 3 | TODO | — |
| 3 | `ai-skills.md` | en→vi | 148 | 8 | TODO | — |

### Ưu tiên 2 — thiếu hẳn bản VI, doc mới của 0.25.0 (2 file)

An toàn nhất: chỉ tạo file mới, không ghi đè gì.

| # | File (rel) | Chiều | Dòng nguồn | parity | Trạng thái | Agent |
|---|---|---|---|---|---|---|
| 5 | `features/caching.md` | en→vi | 60 | — | TODO | — |
| 6 | `roadmap/post-v1.md` | en→vi | 71 | — | TODO | — |

Hai doc mới còn lại của 0.25.0 — `architecture/decisions/adr-012-…` (#4) và
`deployment/performance.md` (#7) — nằm ở §7.5: PR #336 sắp gần như tăng gấp đôi cả hai.

### Ưu tiên 3 — surface release, chặn tag 1.0.0 (2 file, mỗi file một PR)

`v1-release-criteria.md` §5 yêu cầu các doc này khớp code **tại thời điểm tag**, và
docs/en ⇄ docs/vi sync. Chúng dài; đừng gom lô.

| # | File (rel) | Chiều | Dòng nguồn | parity | Trạng thái | Agent |
|---|---|---|---|---|---|---|
| 8 | `getting-started.md` | en→vi | 173 | 2 | TODO | — |
| 9 | `tutorials/nextjs-quickstart.md` | en→vi | 514 | 3 | TODO | — |

Hai doc surface còn lại — `DEPLOYMENT-CHECKLIST.md` (#10) và `api/hono-api-spec.md`
(#11) — cũng ở §7.5. Chúng là 1802 dòng, tức ~19% tổng công của backlog; dịch trước
khi #336 merge là verify + stamp lại toàn bộ hai cặp đó một lần nữa.

### Ưu tiên 4 — phần còn lại, nhỏ trước (46 file)

| # | File (rel) | Chiều | Dòng nguồn | parity | Trạng thái | Agent |
|---|---|---|---|---|---|---|
| 12 | `tutorials/index.md` | en→vi | 43 | 2 | TODO | — |
| 14 | `security/idor-testing.md` | en→vi | 50 | 3 | TODO | — |
| 15 | `compliance/data-residency.md` | en→vi | 54 | 2 | TODO | — |
| 16 | `compliance/data-map.md` | en→vi | 69 | 2 | TODO | — |
| 17 | `features/permission-service-compose-audit.md` | en→vi | 72 | 6 | TODO | — |
| 19 | `compliance/dpa-template.md` | en→vi | 77 | 2 | TODO | — |
| 20 | `compliance/market-us.md` | en→vi | 77 | 2 | TODO | — |
| 21 | `security/route-guards.md` | en→vi | 80 | 1 | TODO | — |
| 22 | `deployment/cloudflare.md` | en→vi | 81 | 4 | TODO | — |
| 23 | `compliance/market-vietnam.md` | en→vi | 83 | 2 | TODO | — |
| 24 | `deployment/overview.md` | en→vi | 83 | 8 | TODO | — |
| 25 | `compliance/provider-google-apple.md` | en→vi | 84 | 2 | TODO | — |
| 26 | `compliance/market-eu-gdpr.md` | en→vi | 89 | 2 | TODO | — |
| 27 | `compliance/README.md` | en→vi | 90 | 3 | TODO | — |
| 28 | `compliance/gap-analysis.md` | en→vi | 91 | 2 | TODO | — |
| 29 | `features/access-manifest-v1.md` | en→vi | 98 | 6 | TODO | — |
| 30 | `features/firebase-sync.md` | vi→en | 108 | 0 | TODO | — |
| 31 | `security/dependency-overrides.md` | en→vi | 110 | 6 | TODO | — |
| 32 | `agent-setup/index.md` | en→vi | 113 | 0 | TODO | — |
| 33 | `features/system-collections-access.md` | en→vi | 118 | 3 | TODO | — |
| 34 | `devpost-xprize-submission.md` | en→vi | 126 | 1 | TODO | — |
| 35 | `compliance/implementation-checklist.md` | en→vi | 127 | 2 | TODO | — |
| 36 | `agent-setup/windsurf.md` | en→vi | 132 | 0 | TODO | — |
| 37 | `README.md` | vi→en | 137 | 2 | TODO | — |
| 38 | `agent-setup/claude-code.md` | en→vi | 137 | 0 | TODO | — |
| 39 | `aio/README.md` | en→vi | 139 | 0 | TODO | — |
| 40 | `agent-setup/cursor.md` | en→vi | 147 | 0 | TODO | — |
| 41 | `features/collections-builder.md` | en→vi | 150 | 2 | TODO | — |
| 42 | `features/search.md` | en→vi | 158 | 4 | TODO | — |
| 43 | `compliance/user-rights-catalog.md` | en→vi | 161 | 2 | TODO | — |
| 44 | `deployment/docker.md` | en→vi | 163 | 6 | TODO | — |
| 45 | `deployment/google-cloud-vm.md` | en→vi | 165 | 4 | TODO | — |
| 46 | `features/typegen.md` | en→vi | 171 | 2 | TODO | — |
| 47 | `features/field-types-and-config.md` | en→vi | 178 | 4 | TODO | — |
| 48 | `security/runtime-security-guards-plan.md` | en→vi | 189 | 3 | TODO | — |
| 49 | `features/websockets-realtime.md` | en→vi | 191 | 2 | TODO | — |
| 50 | `features/observability.md` | vi→en | 195 | 0 | TODO | — |
| 51 | `agent-setup/prompt.md` | en→vi | 202 | 3 | TODO | — |
| 52 | `deployment/local-development.md` | en→vi | 203 | 7 | TODO | — |
| 53 | `security/cwe-top-100-audit.md` | en→vi | 217 | 1 | TODO | — |
| 54 | `deployment/environment-variables.md` | en→vi | 237 | 3 | TODO | — |
| 55 | `features/extensions-system.md` | vi→en | 260 | 2 | TODO | — |
| 56 | `features/role-policy-flag-migration.md` | en→vi | 269 | 1 | TODO | — |
| 57 | `security/anti-abuse.md` | en→vi | 303 | 5 | TODO | — |
| 58 | `features/agent-harness-layer.md` | en→vi | 310 | 8 | TODO | — |
| 60 | `security/owasp-api-top-10-audit.md` | en→vi | 327 | 1 | TODO | — |

Ba file `agent-setup/*` và `aio/README.md` có `parity 0` nhưng vẫn ở đây vì nguồn đã
đổi sau lần sync trước — bản dịch cũ đúng cấu trúc nhưng nội dung lạc hậu. Cấu trúc
sạch không có nghĩa nội dung đúng; đó là lý do `parity` và `verify` là hai script khác nhau.

### 7.5 Chờ upstream — đừng nhận bây giờ

Nguồn EN của 7 file này **đang xếp hàng để đổi** trong PR
[#336](https://github.com/khuepm/LumiBase/pull/336) (high-load P0–P2, đã bỏ draft
2026-08-02). Dịch bây giờ là dịch hai lần: `sourceHash` lệch ngay khi #336 merge, cặp
quay về `planned`, và phải verify + stamp lại từ đầu.

| # | File (rel) | Dòng nguồn | #336 đổi | Vì sao chờ |
|---|---|---|---|---|
| 7 | `deployment/performance.md` | 97 | **+96** | Gần như gấp đôi tài liệu |
| 4 | `architecture/decisions/adr-012-remove-cdc-cache-invalidator.md` | 48 | **+47** | Gần như gấp đôi |
| 59 | `contributing/testing.md` | 312 | +44 | 14% nội dung mới |
| 11 | `api/hono-api-spec.md` | 1239 | +22 | Diff nhỏ, nhưng phải verify + stamp lại 1239 dòng |
| 10 | `DEPLOYMENT-CHECKLIST.md` | 563 | +22 | Như trên |
| 13 | `architecture/decisions/index.md` | 48 | +1 | Đi cùng adr-004/adr-012 |
| 18 | `architecture/decisions/adr-004-tag-based-cache-invalidation.md` | 74 | +1 | Đi cùng #13 |

**Khi #336 merge (hoặc đóng):** chạy lại `pnpm docs:i18n:detect`, chuyển 7 dòng này
lên nhóm ưu tiên phù hợp (#10 và #11 về Ưu tiên 3 — chúng chặn tag; #4 và #7 về Ưu
tiên 2), rồi xoá mục này.

**Backlog là mục tiêu di động khi còn PR mở chạm `docs/en/`.**
[#337](https://github.com/khuepm/LumiBase/pull/337) (CLI) sẽ thêm `docs/en/cli/index.md`
— một doc mới cần bản VI — và làm `release/npm-publishing.md` (đang up-to-date) stale
lại. Nên `planned: 0` chỉ đóng được sau scope freeze (§2 của
`.kiro/steering/v1-release-criteria.md`). Đừng coi con số 53 ở trên là cố định; chạy
detect.

---

## 8. Definition of done

**Một file xong** khi: parity 0 problem · verify 0 finding (hoặc `unverifiable` đã
được ghi rõ) · stamp thành công · detect báo `up-to-date` · bảng §7 đã đổi `DONE` ·
artifact máy sinh không nằm trong commit.

**Một lô xong** khi: mọi file trong lô xong · PR có thân theo mẫu §3 kèm output
checker · không tự merge.

**Toàn bộ backlog xong** khi: `pnpm docs:i18n:detect` báo `planned: 0` và
`pnpm docs:i18n:parity` (không tham số) báo 0 problem trên toàn bộ 146 cặp. Lúc đó
bỏ `|| true` ở hai step parity/verify trong `.github/workflows/docs-i18n-sync.yml`
để từ đó về sau CI chặn thẳng — và mục *docs/en ⇄ docs/vi sync* của
`.kiro/steering/v1-release-criteria.md` §5 được tick.

---

## 9. Vì sao thủ công

`sync.mjs --apply` **có thể** dịch bằng Claude API nếu `ANTHROPIC_API_KEY` được set,
nhưng quyết định của chủ repo là **không** dùng đường đó: chi phí API, cộng với việc
muốn chất lượng dịch đến từ một LLM đọc hiểu trực tiếp thay vì một pipeline không ai
giám sát. Đừng tự thêm key vào môi trường và đừng đề xuất `--apply` để "xong nhanh
hơn" — nếu bạn tin cách đó tốt hơn, hỏi chủ repo, không tự quyết.

Quyết định này được **tooling thi hành**, không chỉ nằm trong văn bản:

- CI không truyền secret nào cho `sync.mjs`; job `push` chỉ chạy `--preserve-only`.
- `--apply` không có key → **exit 2** kèm hướng dẫn, thay vì âm thầm hạ xuống
  `--preserve-only`. Chính cái hạ cấp im lặng đó khiến CI commit "sync en/vi
  translations" hàng tuần trong khi backlog không giảm một file nào.
- Front matter nói thật về xuất xứ: `mtEngine: manual`, `syncStatus: human-translated`.
- `stamp-pair` từ chối đóng dấu một cặp không đạt parity, nên không bản dịch mới nào
  vào được repo mà chưa qua kiểm — đúng chỗ mà một reviewer con người sẽ đứng.
