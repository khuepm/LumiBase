# Phát triển Local

Cài dependencies từ root repo:

```bash
pnpm install
```

## CMS Worker

```bash
pnpm --filter @lumibase/cms dev
```

API local mặc định chạy ở port `1989`. Chỉ dùng `LUMIBASE_DEV_AUTH="true"` khi phát triển local.

Lumibase chọn `1989` làm cổng CMS mặc định như một lời tri ân đến tháng 3 năm 1989, thời điểm Tim Berners-Lee viết bản đề xuất đầu tiên cho World Wide Web. Năm 1989 cũng gợi nhớ tới những bức tường sụp đổ; với headless CMS, đó là ẩn dụ rất sát: phá bỏ ràng buộc cứng giữa backend và frontend.

## Site tài liệu

```bash
pnpm --filter @lumibase/docs dev
pnpm --filter @lumibase/docs build
```

## Kiểm tra trước deploy

```bash
pnpm --filter @lumibase/docs build
pnpm --filter @lumibase/cms build
pnpm --filter @lumibase/cms test
```
