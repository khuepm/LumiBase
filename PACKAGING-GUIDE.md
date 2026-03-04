# 📦 LumiBase Packaging Guide

## 🎯 Hướng Dẫn Đóng Gói và Phân Phối

Tài liệu này hướng dẫn cách đóng gói LumiBase để người khác có thể sử dụng dễ dàng.

## 🚀 Quick Start cho End Users

### Cách 1: Clone và Setup (Đơn giản nhất)

```bash
# Clone repository
git clone https://github.com/yourusername/lumibase-starter.git my-project
cd my-project

# One-command setup
chmod +x scripts/*.sh
./scripts/setup.sh

# Follow prompts to configure .env
# Then run setup again
./scripts/setup.sh
```

### Cách 2: Sử dụng GitHub Template

1. Vào https://github.com/yourusername/lumibase-starter
2. Click "Use this template"
3. Tạo repository mới
4. Clone và chạy setup

### Cách 3: NPM CLI (Coming Soon)

```bash
npx @lumibase/cli init my-project
cd my-project
npm start
```

## 📁 Cấu Trúc Đóng Gói

```
lumibase-starter/
├── docker/                          # Docker configurations
│   ├── docker-compose.yml          # Main compose file
│   └── docker-compose.prod.yml     # Production overrides
├── migrations/                      # Database migrations
│   ├── 001_initial_schema.sql
│   └── README.md
├── directus-snapshots/             # Directus schema exports
│   ├── base-snapshot.yaml
│   └── README.md
├── templates/                      # Pre-built templates
│   ├── ecommerce/
│   │   ├── migrations/
│   │   ├── directus-snapshot.yaml
│   │   └── README.md
│   ├── blog/
│   ├── saas/
│   └── social/
├── scripts/                        # Automation scripts
│   ├── setup.sh                   # One-command setup
│   ├── migrate.sh                 # Run migrations
│   ├── snapshot-export.sh         # Export Directus schema
│   ├── snapshot-import.sh         # Import Directus schema
│   ├── add-template.sh            # Add pre-built template
│   └── reset.sh                   # Reset everything
├── functions/                     # Firebase Cloud Functions
├── client/                        # Client examples
├── docs/                         # Documentation
├── .env.example                  # Environment template
├── package.json
├── README.md
└── PACKAGING-GUIDE.md            # This file
```

## 🛠️ Scripts Chính

### 1. Setup Script (`scripts/setup.sh`)

**Chức năng:**
- Kiểm tra prerequisites (Docker, Node.js)
- Tạo .env từ template
- Generate Directus keys
- Start Docker services
- Run migrations
- Import Directus snapshots

**Sử dụng:**
```bash
./scripts/setup.sh
```

### 2. Migration Script (`scripts/migrate.sh`)

**Chức năng:**
- Chạy tất cả SQL migrations theo thứ tự
- Idempotent (có thể chạy nhiều lần)

**Sử dụng:**
```bash
./scripts/migrate.sh
```

### 3. Snapshot Export (`scripts/snapshot-export.sh`)

**Chức năng:**
- Export Directus schema ra YAML file
- Tạo timestamp snapshot
- Update base-snapshot.yaml symlink

**Sử dụng:**
```bash
./scripts/snapshot-export.sh
```

**Khi nào dùng:**
- Sau khi tạo/sửa collections trong Directus
- Trước khi commit changes
- Để backup schema

### 4. Snapshot Import (`scripts/snapshot-import.sh`)

**Chức năng:**
- Import Directus schema từ YAML file
- Apply vào Directus instance

**Sử dụng:**
```bash
./scripts/snapshot-import.sh directus-snapshots/base-snapshot.yaml
```

### 5. Add Template (`scripts/add-template.sh`)

**Chức năng:**
- Install pre-built template (ecommerce, blog, etc.)
- Run template migrations
- Import template Directus schema
- Seed template data

**Sử dụng:**
```bash
./scripts/add-template.sh ecommerce
```

## 📦 Tạo Template Mới

### Bước 1: Tạo Cấu Trúc

```bash
mkdir -p templates/my-template/migrations
touch templates/my-template/README.md
```

### Bước 2: Viết Migrations

```sql
-- templates/my-template/migrations/001_create_tables.sql
CREATE TABLE IF NOT EXISTS public.my_table (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.my_table ENABLE ROW LEVEL SECURITY;

-- Add policies
CREATE POLICY "Anyone can view"
    ON public.my_table FOR SELECT
    USING (true);
```

### Bước 3: Tạo Collections trong Directus

1. Start Directus: `docker-compose up -d`
2. Login: http://localhost:8055
3. Tạo collections qua UI
4. Export schema:
   ```bash
   ./scripts/snapshot-export.sh
   cp directus-snapshots/schema-*.yaml templates/my-template/directus-snapshot.yaml
   ```

### Bước 4: Document Template

```markdown
# My Template

## What's Included
- Table 1: Description
- Table 2: Description

## Installation
\`\`\`bash
./scripts/add-template.sh my-template
\`\`\`

## Usage
...
```

## 🔄 Workflow cho Người Dùng

### Workflow 1: Bắt Đầu Dự Án Mới

```bash
# 1. Clone/Create từ template
git clone https://github.com/yourusername/lumibase-starter.git my-app
cd my-app

# 2. Setup
./scripts/setup.sh
# Edit .env với credentials
./scripts/setup.sh

# 3. Add template (optional)
./scripts/add-template.sh ecommerce

# 4. Start developing
open http://localhost:8055
```

### Workflow 2: Thêm Collections Mới

```bash
# 1. Tạo collection trong Directus UI
open http://localhost:8055

# 2. Export schema
./scripts/snapshot-export.sh

# 3. Commit changes
git add directus-snapshots/
git commit -m "feat: add new collection"
```

### Workflow 3: Migrate Database Changes

```bash
# 1. Viết migration file
nano migrations/003_add_new_table.sql

# 2. Run migration
./scripts/migrate.sh

# 3. Update Directus (if needed)
./scripts/snapshot-import.sh directus-snapshots/base-snapshot.yaml
```

### Workflow 4: Update từ Upstream

```bash
# 1. Add upstream remote (one time)
git remote add upstream https://github.com/yourusername/lumibase-starter.git

# 2. Fetch updates
git fetch upstream

# 3. Merge updates
git merge upstream/main

# 4. Resolve conflicts (mainly .env, custom code)

# 5. Run migrations
./scripts/migrate.sh
```

## 🎨 Tùy Chỉnh cho Dự Án

### Tùy Chỉnh Docker

```yaml
# docker-compose.override.yml
version: '3.8'

services:
  directus:
    environment:
      # Custom environment variables
      MY_CUSTOM_VAR: value
    ports:
      # Custom ports
      - "9000:8055"
```

### Tùy Chỉnh Migrations

```bash
# Thêm migration mới
cat > migrations/010_custom_feature.sql << 'EOF'
-- Your custom SQL here
CREATE TABLE ...
EOF

# Run migration
./scripts/migrate.sh
```

### Tùy Chỉnh Directus

1. Tạo extensions trong `directus_extensions` volume
2. Customize theme/branding
3. Add custom endpoints

## 📊 Resource Optimization Strategies

### Strategy 1: Shared PostgreSQL (Development)

Nhiều projects dùng chung một PostgreSQL instance:

```yaml
# docker-compose.shared.yml
services:
  postgres-shared:
    image: postgres:15-alpine
    ports:
      - "5432:5432"
    volumes:
      - postgres_shared:/var/lib/postgresql/data
```

Mỗi project tạo database riêng:
```bash
docker exec postgres-shared psql -U postgres -c "CREATE DATABASE project1;"
docker exec postgres-shared psql -U postgres -c "CREATE DATABASE project2;"
```

### Strategy 2: Cloud-Based (Production)

- **PostgreSQL**: Supabase (free tier: 500MB)
- **Directus**: Railway.app / Render.com
- **Firebase**: Free tier

### Strategy 3: Docker Compose Profiles

```yaml
# docker-compose.yml
services:
  postgres:
    profiles: ["full", "db"]
  
  directus:
    profiles: ["full", "cms"]
```

Chạy chỉ services cần thiết:
```bash
docker-compose --profile db up      # Only PostgreSQL
docker-compose --profile cms up     # Only Directus
docker-compose --profile full up    # Everything
```

## 🚀 Distribution Options

### Option 1: GitHub Template Repository ⭐ (Khuyến nghị)

**Ưu điểm:**
- Dễ sử dụng
- Git history sạch
- Dễ customize

**Setup:**
1. Push code lên GitHub
2. Settings → Template repository → Check
3. Users click "Use this template"

### Option 2: NPM Package

**Ưu điểm:**
- Professional
- Easy updates
- Version management

**Setup:**
```json
// package.json
{
  "name": "@lumibase/starter",
  "version": "1.0.0",
  "bin": {
    "lumibase": "./bin/cli.js"
  }
}
```

### Option 3: Docker Image

**Ưu điểm:**
- Simplest setup
- Consistent environment

**Setup:**
```dockerfile
FROM directus/directus:10-latest
COPY migrations /migrations
COPY scripts /scripts
```

## 📝 Best Practices

### 1. Migrations

- ✅ Migrations are immutable (không sửa cũ, tạo mới)
- ✅ Use IF NOT EXISTS
- ✅ Include rollback instructions
- ✅ Test migrations trước khi commit

### 2. Snapshots

- ✅ Export sau mỗi thay đổi lớn
- ✅ Commit vào Git
- ✅ Document changes trong commit message
- ✅ Keep old snapshots for rollback

### 3. Environment Variables

- ✅ Never commit .env
- ✅ Document all variables trong .env.example
- ✅ Use strong passwords
- ✅ Rotate keys regularly

### 4. Documentation

- ✅ Update README khi có changes
- ✅ Document custom modifications
- ✅ Include troubleshooting guide
- ✅ Provide examples

## 🐛 Troubleshooting

### Scripts không chạy được

```bash
# Make scripts executable
chmod +x scripts/*.sh
```

### Migration fails

```bash
# Reset và thử lại
docker-compose down -v
docker-compose up -d
./scripts/migrate.sh
```

### Directus không import được snapshot

```bash
# Check file exists
ls -la directus-snapshots/

# Check Directus is running
curl http://localhost:8055/server/health

# Try manual import
docker-compose exec directus npx directus schema apply /directus/snapshots/base-snapshot.yaml
```

## 📚 Resources

- [Kiến Trúc Đóng Gói Chi Tiết](docs/PACKAGING-ARCHITECTURE.md)
- [E-commerce Template](templates/ecommerce/README.md)
- [Directus Schema Docs](https://docs.directus.io/configuration/data-model/)
- [PostgreSQL Migrations](https://www.postgresql.org/docs/current/ddl.html)

## 🎯 Next Steps

1. ✅ Tạo thêm templates (blog, saas, social)
2. ✅ Build NPM CLI tool
3. ✅ Create video tutorials
4. ✅ Setup marketplace cho templates
5. ✅ Add CI/CD cho template testing

---

**Happy Building! 🚀**
