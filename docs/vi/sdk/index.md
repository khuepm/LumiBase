---
version: 2
lastUpdated: 2026-09-09T02:49:02.007Z
sourceLang: en
translatedFrom: en
sourceHash: 9ad56a846efd4625
mtEngine: manual
syncStatus: human-translated
---

# Tài liệu tham khảo SDK

> **Dành cho AI agent:** Xem `docs/en/llms.txt` để có chỉ mục tài liệu đầy đủ.

LumiBase cung cấp một SDK JavaScript/TypeScript chính thức để tương tác với API mà không cần viết các yêu cầu HTTP thô.

## Packages

| Package | Cài vào | Mô tả |
|---------|---------|-------------|
| `lumibase` | `dependencies` | **Bắt đầu ở đây.** Cùng một client được re-export, kèm CLI `lumibase` (`types`, `doctor`, `init`) — một tên cho cả hai. |
| `@lumibase/sdk` | `dependencies` | SDK client JS/TS ở tầng dưới — items, auth, files, realtime, AI Copilot. Dùng trực tiếp khi bạn chỉ muốn client mà không cần CLI. |

```bash
npm install lumibase
```

```ts
// giống hệt @lumibase/sdk
import { createLumiClient } from 'lumibase';
```

`lumibase` *phụ thuộc vào* `@lumibase/sdk` chứ không bundle lại, nên dự án import
cả hai vẫn chỉ có một bản duy nhất của mỗi class (các phép kiểm tra
`LumiError` `instanceof` vẫn hoạt động) và một bộ type duy nhất. Chưa rõ mình đang
đi theo hướng nào? Xem
[cây quyết định trong Getting Started](../getting-started.md#which-path-do-i-need).

## Hướng dẫn

- [JavaScript SDK](./javascript.md) — tham khảo đầy đủ API client kèm ví dụ
- [TypeGen](./typegen.md) — sinh kiểu TypeScript từ schema đang chạy của bạn
