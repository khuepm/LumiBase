---
title: Tài liệu tham khảo SDK
version: 2
lastUpdated: 2026-09-21T05:45:14.986Z
sourceLang: en
translatedFrom: en
sourceHash: 8a51c4697f0696d0
mtEngine: manual
syncStatus: human-translated
---

# Tài liệu tham khảo SDK

> **Dành cho AI agent:** Xem `docs/en/llms.txt` để có chỉ mục tài liệu đầy đủ.

LumiBase cung cấp một SDK JavaScript/TypeScript chính thức để tương tác với API mà không cần viết các yêu cầu HTTP thô.

## Packages

| Package | Cài vào | Mô tả |
|---------|-----------|-------------|
| `lumibase` | `dependencies` | **Bắt đầu ở đây.** Cùng một client được re-export, kèm CLI `lumibase` (`types`, `doctor`, `init`) — một cái tên cho cả hai. |
| `@lumibase/sdk` | `dependencies` | SDK client JS/TS bên dưới — items, auth, files, realtime, AI Copilot. Dùng trực tiếp khi bạn muốn client mà không cần CLI. |

```bash
npm install lumibase
```

```ts
// identical to @lumibase/sdk
import { createLumiClient } from 'lumibase';
```

Dù chọn cách nào thì nó cũng thuộc `dependencies`, không phải `devDependencies`
— app của bạn import nó lúc chạy request. `lumibase` *phụ thuộc vào*
`@lumibase/sdk` chứ không bundle sẵn, nên một project import cả hai vẫn chỉ có
một bản của mỗi class (kiểm tra `LumiError` `instanceof` vẫn đúng) và một bộ
type. Chưa rõ mình đang đi đường nào? Xem
[Bạn thật sự cần cái nào?](../getting-started.md#bạn-thật-sự-cần-cái-nào)
trong Getting Started.

## Hướng dẫn

- [JavaScript SDK](./javascript.md) — tham khảo đầy đủ API client kèm ví dụ
- [TypeGen](./typegen.md) — sinh kiểu TypeScript từ schema đang chạy của bạn
