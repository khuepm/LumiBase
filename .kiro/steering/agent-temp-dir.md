# Agent temp directory — không dùng /tmp

Mọi file tạm của agent (scratch, log, output đo, bundle thử, `mktemp`) phải nằm **trong workspace**, không ghi vào `/tmp` hay `/private/tmp`. Ghi ra ngoài workspace bắt người dùng duyệt quyền mỗi lần.

- Thư mục tạm: `/Users/khuepm/workplace/AI/Lumibase/.agents/tmp/` (đã tồn tại; `.agents/` và `.worktrees/` bị ignore cục bộ qua `.git/info/exclude`, không commit).
- Đang làm trong worktree `.worktrees/<name>` thì vẫn dùng đúng thư mục trên (đường dẫn tuyệt đối), không tạo `/tmp/...`.
- Lệnh tự tạo file tạm (`mktemp`, Node `os.tmpdir()`, vitest, turbo, esbuild, wrangler) → chạy kèm `TMPDIR=/Users/khuepm/workplace/AI/Lumibase/.agents/tmp`, ví dụ:
  ```bash
  TMPDIR=/Users/khuepm/workplace/AI/Lumibase/.agents/tmp pnpm test
  out=$(TMPDIR=/Users/khuepm/workplace/AI/Lumibase/.agents/tmp mktemp)
  ```
- Artifact của một workflow run (plan, review, verification, log dài) đặt trong run dir `.agents/tasks/<run>/`, không phải thư mục tạm.
- Dọn file tạm do chính mình tạo khi xong việc.
