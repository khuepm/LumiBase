# Kế hoạch 20 sprint — 2026-11-19 → 2027-02-25

> Lập ngày 2026-11-19, ngay sau khi gộp hàng đợi v2.2.0 (PR #944).
> Mỗi sprint dài 3–7 ngày lịch và có ít nhất một epic. Ngày tháng là mục tiêu
> để xếp thứ tự, không phải cam kết: release vẫn theo cổng chất lượng và cần
> GO của release owner (#890, #891, #892).
>
> Ước lượng dựa trên số issue/PR đang mở, chưa có số đo velocity thực tế. Sau
> sprint 3 nên so lại số issue đóng được mỗi sprint rồi chỉnh các sprint sau.

## Tổng quan

| # | Ngày | Dài | Epic chính | Mốc |
|---|---|---|---|---|
| 1 | 19–21/11 | 3 | #673 Data, #669 Rich text | **v2.2.0** |
| 2 | 22–25/11 | 4 | #869 Release flags | |
| 3 | 26–30/11 | 5 | #670 DAM | |
| 4 | 01–04/12 | 4 | #667 Visual editing | |
| 5 | 05–09/12 | 5 | #853 Content Environments (B) | |
| 6 | 10–16/12 | 7 | #853 Content Environments (C, D) | |
| 7 | 17–19/12 | 3 | #853 + #869 phần 2 | **v2.3.0** |
| 8 | 20–23/12 | 4 | #361 MCP | |
| 9 | 24–30/12 | 7 | #361 MCP | **v2.4.0** |
| 10 | 31/12–04/01 | 5 | #671 AI & agent skills | |
| 11 | 05–09/01 | 5 | #900 Backend Templates (BT01–04) | |
| 12 | 10–14/01 | 5 | #900 Backend Templates (BT05–09) | **v2.5.0** |
| 13 | 15–19/01 | 5 | #672 Memberships | |
| 14 | 20–23/01 | 4 | #672 Newsletters | **v2.6.0** |
| 15 | 24–28/01 | 5 | #870 Forms | |
| 16 | 29/01–01/02 | 4 | #870 Forms, #668 Editorial UX | **v2.7.0** |
| 17 | 02–08/02 | 7 | #643 Marketplace (M01–M07) | |
| 18 | 09–13/02 | 5 | #643 Marketplace (M08–M18) | **v2.8.0** |
| 19 | 14–18/02 | 5 | #854 Co-editing | |
| 20 | 19–25/02 | 7 | #854 Co-editing, #872 Multi-region (ADR) | |

Quy ước chung cho mọi sprint: DoD (`definition-of-done.md`), reviewer độc lập
trước khi merge (`lane-process.md`), docs song ngữ, dòng Setup Impact Registry.
Số migration chỉ chốt lúc merge; nhiều PR cùng thêm migration thì gộp vào một
nhánh tích hợp và chạy `migration-journal.test.ts`.

## Sprint 1 — 19–21/11 (3 ngày) — phát hành v2.2.0

- **Epic:** #673 Data import/export, #669 Rich text.
- **Việc:**
  - Merge PR #944 (gộp #849, #850, #880, #881, #884, #876, #874, #899, #894).
  - #888 trang Studio chỉ đọc trạng thái flag.
  - #889 nâng cấp v2.1.0 → v2.2.0 trên DB có dữ liệu thật, backup/restore, job hàng đợi cũ khi rolling upgrade.
  - Ghi chú phát hành: import đang chạy phải được xả hết hoặc nâng cấp mọi replica cùng lúc (worker cũ không đọc được job dạng chunk).
  - CHANGELOG v2.2, hướng dẫn upgrade/rollback, `/release`.
- **Điều kiện xong:** mọi ô của cổng GO/NO-GO trong #890 có bằng chứng; release owner ghi GO.

## Sprint 2 — 22–25/11 (4 ngày) — Release flags và nợ sau v2.2

- **Epic:** #869 Release flags.
- **Việc:**
  - #896 đưa các flag hiện có (`contentOs.*`, `files.dam`, `openapi`) vào registry.
  - #897 hạ tầng phát hành: giữ khoá, publish manifest đã ký, pull lúc khởi động.
  - #895 trang Studio: toggle theo site.
  - Phát hiện từ đợt review v2.2: SCIM `POST /Groups` gắn `user_sites` theo id mà không kiểm tra; `runImportTick` xếp hạng bỏ qua giới hạn đồng thời; KV metadata > 1024 byte làm URL không bao giờ được purge; quét dependents rich text giới hạn 1000 dòng không sắp xếp.
  - Nợ docs: #817, #818, #819, #820, #821, #822.
- **Điều kiện xong:** flag bật/tắt qua manifest trên staging; bốn phát hiện review có issue và bản sửa hoặc quyết định hoãn có lý do.

## Sprint 3 — 26–30/11 (5 ngày) — DAM

- **Epic:** #670 Digital asset management.
- **Việc:** PR #933 (media picker, #708), #935 (ClamAV, #707), #936 (TUS, #704), #937–#939 (video pipeline, captions, Studio; #871). Gộp vào `epic/670-dam`, chốt số migration (năm PR cùng thêm idx 41).
- **Điều kiện xong:** upload nối lại được trên R2 và S3; file nhiễm bị cách ly; HLS phát được trên Workers và Docker.

## Sprint 4 — 01–04/12 (4 ngày) — Visual editing

- **Epic:** #667 Visual editing & live preview.
- **Việc:** PR #940 (#682 preview release/version), #941 + #942 (#684 page composer backend và UI). #694 chỉnh điều hướng Studio.
- **Điều kiện xong:** preview một release và một content version trong Studio; composer lưu `layoutConfig` v1 qua validation; kiểm tra lại threat model ADR-014.

## Sprint 5 — 05–09/12 (5 ngày) — Content Environments, pha B

- **Epic:** #853 Content Environments.
- **Việc:** PR #886 (#868 tripwire + composite FK); đối chiếu lại spec #853 với code trên `main`; fork và cô lập environment kèm test về quyền, asset, tham chiếu và job nền theo site.
- **Điều kiện xong:** không rò rỉ giữa environment trong test Postgres thật; flag `content-environments` vẫn dark.

## Sprint 6 — 10–16/12 (7 ngày) — Content Environments, pha C và D

- **Epic:** #853.
- **Việc:** promote schema có duyệt tay và phát hiện xung đột (pha C); promote nội dung một chiều có audit, provenance và kế hoạch rollback (pha D). Three-way merge và UI hoàn thiện để sau nếu pha D đã dùng được.
- **Điều kiện xong:** fixture fork → sửa → promote, xung đột ép buộc và rollback đều qua trên Postgres thật.

## Sprint 7 — 17–19/12 (3 ngày) — phát hành v2.3.0

- **Epic:** #853, #869 phần 2.
- **Việc:** smoke Docker + Workers, docs phát hành, cổng GO của #891. #898 nút Upgrade trong app (preflight, deploy hook, tiến độ) nếu #897 đã xong; nếu chưa thì dời sang sprint 8.
- **Điều kiện xong:** GO của #891 được ghi; bật `content-environments` qua manifest.

## Sprint 8 — 20–23/12 (4 ngày) — MCP resources và prompts

- **Epic:** #361 MCP spec compliance.
- **Việc:** #344 resources cho nội dung và schema; #345 prompts theo site; #716 bộ test độ trung thực tool-schema.
- **Điều kiện xong:** không truy cập chéo site; capability floor áp cho resources.

## Sprint 9 — 24–30/12 (7 ngày) — MCP transport, phát hành v2.4.0

- **Epic:** #361.
- **Việc:** #347 streamable HTTP + SSE và `tools/list_changed`; ma trận test với client thật (OAuth, refresh, reconnect); đối chiếu HTTP và stdio; #454, #472 nếu còn mở. Sprint dài vì trùng kỳ nghỉ.
- **Điều kiện xong:** cổng GO của #892.

## Sprint 10 — 31/12–04/01 (5 ngày) — AI và agent skills

- **Epic:** #671 AI assistant, agent skills & MCP extensibility.
- **Việc:** #710 `ask_user`; #712 Skills do site viết và `lumibase skills install`; #709 Copilot đa phương thức (ảnh, PDF); #711 agent trong Slack nếu còn sức; #455 vòng sửa bản dịch G3.
- **Điều kiện xong:** mỗi tính năng qua harness (capability, autonomy, HITL) và có eval trong `ai-evaluation.yml`.

## Sprint 11 — 05–09/01 (5 ngày) — Backend Templates, nền tảng

- **Epic:** #900 Backend Templates.
- **Việc:** merge spec PR #911; #901 BT01 hợp đồng JSON có phiên bản; #902 BT02 catalog theo site; #903 BT03 planner cài đặt; #904 BT04 instantiate nguyên tử + provenance.
- **Điều kiện xong:** cài một template vào site trống là nguyên tử; xung đột bị planner chặn trước khi ghi.

## Sprint 12 — 10–14/01 (5 ngày) — Backend Templates, hoàn thiện, v2.5.0

- **Epic:** #900.
- **Việc:** #905 BT05 seed pack; #906 BT06 tool MCP có quản trị; #907 BT07 template mẫu kiểu WordPress; #908 BT08 thư viện template trong Studio; #909 BT09 nghiệm thu và docs. #910 BT10 (nâng cấp template đã cài) để sau.
- **Điều kiện xong:** tạo backend từ template qua Studio và qua MCP; tool `schema:write` chờ duyệt.

## Sprint 13 — 15–19/01 (5 ngày) — Memberships

- **Epic:** #672 Memberships, newsletters & audience.
- **Việc:** review lại và merge PR #851 trên head mới; #717 hồ sơ thành viên, tier, portal API; #718 widget Portal; #723 segment tự cập nhật.
- **Điều kiện xong:** realm frontend không leo quyền sang staff; SAR và xoá dữ liệu bao phủ thành viên.

## Sprint 14 — 20–23/01 (4 ngày) — Newsletters, v2.6.0

- **Epic:** #672.
- **Việc:** #719 newsletter như một kênh; #720 chuỗi email tự động dạng Flow template; #721 block signup card; #722 domain gửi riêng (DKIM, DMARC).
- **Điều kiện xong:** gửi thử tới segment trên staging; huỷ đăng ký và bounce được xử lý.

## Sprint 15 — 24–28/01 (5 ngày) — Forms, backend

- **Epic:** #870 Forms.
- **Việc:** #919 ADR mô hình lưu trữ; #920 mô hình định nghĩa form; #921 endpoint nhận submission công khai (rate limit, honeypot, giới hạn kích thước); #922 chuyển submission tới Flows, email, webhook, CDC.
- **Điều kiện xong:** endpoint công khai qua bộ test chống lạm dụng; mọi truy vấn có `site_id`.

## Sprint 16 — 29/01–01/02 (4 ngày) — Forms UI và Editorial UX, v2.7.0

- **Epic:** #870, #668 Collaborative editing & editorial UX.
- **Việc:** #923 PII (lưu giữ, xoá, SAR); #924 form builder và hộp submission trong Studio; #925 SDK và block nhúng; #686 so sánh revision cạnh nhau; #685 presence và soft lock; #691 widget dashboard.
- **Điều kiện xong:** form nhúng chạy trong starter Next.js; presence chạy trên Workers và Docker.

## Sprint 17 — 02–08/02 (7 ngày) — Marketplace, xuất bản độc lập

- **Epic:** #643 Extension Marketplace.
- **Việc:** #644 M01, #645 M02, #646 M03, #647 M04, #648 M05, #649 M06, #650 M07.
- **Điều kiện xong:** `lumibase-ext publish` đẩy được một extension lên catalog công khai; bundle được xác minh lại lúc cài.

## Sprint 18 — 09–13/02 (5 ngày) — Marketplace, extension chính thức và định giá, v2.8.0

- **Epic:** #643.
- **Việc:** #651 M08, #652 M09, #653 M10, #654 M11 (gỡ submodule `extensions/`); #655 M12, #656 M13; #659 M16, #660 M17, #661 M18, #657 M14. Thanh toán thật (#662, #663) và dashboard publisher (#658) nằm ngoài 20 sprint này.
- **Điều kiện xong:** extension chính thức tự cài trên prod từ repo riêng; luồng pay-what-you-want chạy với cổng thanh toán giả lập; #665 docs và security review.

## Sprint 19 — 14–18/02 (5 ngày) — Co-editing, nền tảng

- **Epic:** #854 Real-time co-editing.
- **Việc:** #913 ADR (CRDT hay OT, chọn thư viện); #914 ánh xạ tài liệu chia sẻ sang `items.data` và revisions; #915 transport đồng bộ trên SiteRoom và node-hub; #354 fan-out đa node cho Docker.
- **Điều kiện xong:** hai client sửa cùng một item và hội tụ trên cả hai runtime, sau flag dark.

## Sprint 20 — 19–25/02 (7 ngày) — Co-editing hoàn thiện, khởi động Multi-region

- **Epic:** #854, #872 Multi-region data.
- **Việc:** #916 quyền field và masking trong phiên co-editing; #917 gắn editor, con trỏ từ xa, offline và reconnect; #918 tương tác với release, content version và agent; #926 ADR phạm vi multi-region; #932 benchmark đọc có xác thực trước read replica.
- **Điều kiện xong:** co-editing không lộ field bị che; ADR #926 được duyệt để xếp #927–#931 vào đợt kế hoạch sau.

## Chưa xếp vào 20 sprint

- #362 GitOps hai chiều (#348–#352, #765–#767), #363 Change Feed (#353, #355), #364 Authz (#356–#358).
- #678 Personalisation, A/B, commerce (#762–#764); #724 ActivityPub; #725 bình luận độc giả; #758 Figma.
- #893 adapter Strapi/Sanity/WordPress; #734 image production cứng hoá; #741 nút deploy một chạm.
- #331 must-install dependency; #359 ứng dụng tham chiếu và benchmark; #798 plugin ChatGPT.
- #934 picomatch: chờ bản vá upstream, audit CI còn đỏ tới lúc đó.
- #885 landing storybook (thử nghiệm, PR #943 đi kèm).

Nên chèn #734 và #934 vào sprint nào có chỗ trống trước v2.3.0, vì cả hai nằm
trên đường đi của cổng bảo mật ở mọi release.
