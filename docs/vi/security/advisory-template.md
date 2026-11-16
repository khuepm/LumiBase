---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T01:59:40.964Z
translatedFrom: en
sourceHash: db84dfc33d0b34e2
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-14T01:59:40.964Z
codeVerifiedHash: db84dfc33d0b34e2
codeVerifiedClaims: 2
---

# Mẫu bài advisory và CVE

Maintainer sao chép các khối dưới đây khi viết một GitHub Security Advisory
(GHSA), dòng `CHANGELOG.md` tương ứng, và các tin trả lời người báo cáo. Quy trình
xung quanh chúng là [runbook advisory](./advisory-runbook.md); các quy tắc mà
chúng thực thi là [chính sách công bố lỗ hổng](./vulnerability-disclosure.md).

Advisory, mô tả CVE và tin trả lời người báo cáo được viết bằng **tiếng Anh**, ngôn
ngữ của GitHub Advisory Database và cve.org, nên các khối mẫu bên dưới giữ nguyên
tiếng Anh. Placeholder nằm trong `<angle brackets>`; hãy xoá mục nào không áp
dụng thay vì để trống.

## Các trường của form GHSA

| Trường | Nhập gì |
|--------|---------|
| Title | `<Component>: <weakness> allows <actor> to <impact>` — ví dụ "CMS: missing site scope on item export allows an authenticated user to read another site's items". Dưới 100 ký tự, không ghi số phiên bản. |
| CVE identifier | Để "Request CVE ID later" cho tới khi triage xong; yêu cầu CVE từ bản nháp trước khi công bố (runbook §6). |
| Ecosystem / package | `npm` và tên package đối với package npm. Với CMS, Docker image của nó, Studio hoặc shell, chọn `Other` và tên sản phẩm `lumibase`. Mỗi package bị ảnh hưởng một mục. |
| Affected versions | Mỗi major được hỗ trợ một khoảng, ví dụ `>= 2.0.0, < 2.0.1` và `>= 1.0.0, < 1.0.2`. |
| Patched versions | Phiên bản đã sửa đầu tiên của mỗi khoảng, ví dụ `2.0.1`, `1.0.2`. |
| Severity | Dùng bộ tính CVSS trong form; vector sẽ được công bố. Áp dụng mức sàn ở chính sách §4. |
| Weaknesses (CWE) | CWE cụ thể nhất, ví dụ `CWE-639` (authorization bypass through user-controlled key) cho lỗi vượt qua cô lập tenant. |
| Credits | Người báo cáo với vai trò "Reporter"; ai viết hoặc review bản sửa là "Remediation developer" hoặc "Remediation reviewer". Bỏ qua với người báo cáo ẩn danh. |

## Mô tả advisory

```markdown
### Summary

<One or two sentences: what is wrong, who can exploit it, what they gain.>

### Affected versions

| Component | Affected | Patched |
|-----------|----------|---------|
| <CMS (Workers and Docker image ghcr.io/khuepm/lumibase-cms)> | <>= 2.0.0, < 2.0.1> | <2.0.1> |
| <CMS 1.0.x line> | <>= 1.0.0, < 1.0.2> | <1.0.2> |

Deployments on <Cloudflare Workers / Docker / both> are affected.
<State any configuration that is required for exposure, or "in the default configuration".>

### Impact

<What an attacker can read, change or execute, and which trust boundary
(tenant, organization, role, approval gate, secret) is crossed. State the
privileges the attacker needs.>

### Patches

Fixed in <2.0.1> and <1.0.2>. Upgrade to the patched release for your major.
Docker: `ghcr.io/khuepm/lumibase-cms:<2.0.1>`. npm: `<package>@<version>`.
<Say whether a migration or any operator action is needed after upgrading.>

### Workarounds

<Mitigations for operators who cannot upgrade at once, e.g. revoke a key type,
disable a route at the proxy, turn off a feature flag. Write "None. Upgrade." if
there is none.>

### Detection

<How an operator can tell whether this was exploited: audit-log action names,
log lines, queries. Omit if there is no reliable signal.>

### References

- <Fix commit or pull request>
- <Release notes for 2.0.1>
- <Relevant LumiBase docs page>

### Credits

Reported by <name or handle>. <Thanks to … for the fix review.>
```

Công bố chi tiết proof of concept cùng advisory hoặc tối đa 14 ngày sau đó
(chính sách §7). Khi thêm vào, chúng nằm dưới `### Details`, giữa Impact và
Patches.

## Dòng CHANGELOG

Dưới `### Security` trong phần `CHANGELOG.md` của bản release đã sửa, và trong mục
`## Security` của `.github/RELEASE_TEMPLATE.md` cho GitHub Release mà
`.github/workflows/release.yml` công bố:

```markdown
### Security
- <Component>: <one-sentence fix description, in the past tense, without exploit detail>. <Severity> (CVSS <score>). [GHSA-xxxx-xxxx-xxxx](https://github.com/khuepm/lumibase/security/advisories/GHSA-xxxx-xxxx-xxxx), CVE-YYYY-NNNNN. Reported by <name or handle>.
```

## Dòng cho bảng chỉ mục advisory

Cho bảng trên trang [security advisory](./advisories.md#advisory-đã-công-bố):

```markdown
| [GHSA-xxxx-xxxx-xxxx](https://github.com/khuepm/lumibase/security/advisories/GHSA-xxxx-xxxx-xxxx) — <title> | CVE-YYYY-NNNNN | <High> | <2.0.0; 1.0.0–1.0.1> | <2.0.1; 1.0.2> | <YYYY-MM-DD> |
```

## Tin trả lời người báo cáo

### Trả lời: xác nhận đã nhận

```markdown
Thanks for the report. We have received it and will triage it within 7 business
days of a complete report (version, reproduction steps, working PoC). We will
keep you updated in this thread. Please keep the details private while we work
on it; our policy is at https://github.com/khuepm/lumibase/blob/main/docs/en/security/vulnerability-disclosure.md.
```

### Trả lời: kết quả triage

```markdown
We reproduced this on <version>. We rate it <severity> (CVSS <vector>), affecting
<versions>. Our target for a fixed release is <date>. <We will request a CVE ID.>
Would you like to be credited, and under what name? You are welcome to review
the fix in the temporary private fork; let us know.
```

### Trả lời: cần proof of concept chạy được

```markdown
Thanks for the report. We could not reproduce it from the information given.
Our policy requires a working proof of concept against a supported version
(https://github.com/khuepm/lumibase/blob/main/docs/en/security/vulnerability-disclosure.md#8-ai-generated-and-automated-reports):
the exact version or commit, steps from a clean install, and the requests or
script with the output you observed. Please add them here within 14 days;
otherwise we will close this report. It can be reopened when a PoC is available.
```

### Trả lời: đóng — không phải báo cáo lỗ hổng

```markdown
We are closing this report without further action. <It cites code that does not
exist in LumiBase: <file/function/route>.> / <It is scanner or AI output without
a demonstrated impact.> / <The impact does not cross a boundary in our scope.>
If you can show a working proof of concept against a supported version, reply
here and we will reopen it.
```

### Trả lời: đã công bố

```markdown
The fix is released in <versions> and the advisory is published:
<GHSA URL> (<CVE ID>). Thank you for reporting it and for keeping it private
until now. You are free to publish your own write-up.
```
