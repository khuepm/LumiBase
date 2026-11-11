# Requirements — Site Skills (#712, epic #671 A04)

Nguồn: `.kiro/research/competitor-features-2026-07.md` (A8) — Sanity Skills
platform + `skills install`, Medusa Agent Skills, Strapi Claude Code skill.
Chủ đề chéo #2 của bản khảo sát: *skills, receipts, provenance cho agent là lợi
thế governed-harness của LumiBase nhưng chưa được đưa ra bề mặt*.

## Vì sao đây là mục ưu tiên số một của danh sách

- Mọi mục AI khác của epic #671 (Copilot đa phương thức, Content Agent trong
  Slack, translation generator, migration skills) đều cần một nơi để site nói
  "ở đây làm việc như thế này". Không có nó, mỗi tính năng tự hard-code prompt.
- Nó biến hành vi agent thành **config có phiên bản, có provenance** — đúng
  triết lý Config-as-Code và "humans set intent, taste, accountability".
- `pull`/`push --check` cho phép triển khai hành vi agent bằng CI, không thao
  tác tay.

## Requirements (EARS)

1. **Lưu trữ.** Hệ thống PHẢI lưu skill theo site (`site_id`, slug duy nhất
   trong site) gồm front matter (scope, risk class, capability) và thân Markdown.
2. **Phiên bản + provenance.** KHI nội dung một skill đổi, hệ thống PHẢI thêm
   một phiên bản bất biến ghi tác giả, nguồn, hash sha256; ghi không đổi nội
   dung KHÔNG được tạo phiên bản.
3. **Chỉ skill `active` được chèn.** Skill mới PHẢI ở `draft`.
4. **Chèn vào run.** KHI một run khớp phạm vi của skill active, harness PHẢI
   thêm thân skill vào chỉ dẫn: Copilot chat (đồng bộ và async cho cùng kết
   quả), các generation tool, và MCP `prompts/*`.
5. **Không nới governance.** Skill KHÔNG ĐƯỢC cấp capability/tool, đổi định
   dạng output, hay vượt HITL/autonomy/kill switch/constitution.
6. **Fail closed.** Skill có `requiredCapabilities` KHÔNG được chèn khi
   capability của người gọi không được biết; collection không biết KHÔNG có
   nghĩa là áp dụng.
7. **Ngân sách.** Số skill và số ký tự chèn vào một run PHẢI có trần; skill
   không vừa bị bỏ nguyên cả skill, không cắt cụt.
8. **Dấu vết.** Mỗi lần chèn PHẢI được ghi `{slug, version, hash}` trên kết
   quả của run.
9. **Quản trị ghi.** Ghi cần `skills:write` hoặc control-plane admin;
   `riskClass: high` chỉ admin theo mọi chiều.
10. **Skills as code.** CLI PHẢI có `skills list|pull|push|install`; `push` và
    `install` idempotent; `push --check` là cổng CI.
11. **Cô lập tenant.** Site B KHÔNG thấy/khớp/sửa skill của site A.
12. **Nâng cấp an toàn.** Code chạy trước migration KHÔNG được làm fail agent
    run.
13. **Studio.** Mission Control có tab Skills: danh sách, soạn thảo, vòng đời,
    vết phiên bản + khôi phục, xem trước match.

## Tiêu chí chấp nhận của issue

- "Editor viết skill house style → output agent tuân theo trong benchmark":
  được chứng minh ở mức *chỉ dẫn tới model* (test khẳng định thân skill nằm
  trong system slot của lời gọi và được đóng dấu trên kết quả). Benchmark chất
  lượng output với model thật — xem tasks.md mục 7 (chưa làm).
- "Skills versioned with provenance": Req 2, 8.
