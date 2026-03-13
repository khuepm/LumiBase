# 📦 Kiến Trúc Đóng Gói LumiBase

## 🎯 Mục Tiêu

Đóng gói LumiBase thành một **starter kit** có thể tái sử dụng, cho phép người dùng:
- Clone và chạy ngay với minimal configuration
- Tùy chỉnh schema và collections dễ dàng
- Migrate database schema khi có thay đổi
- Tránh lãng phí resources (không duplicate Directus, PostgreSQL)

## 🏗️ Kiến Trúc Đề Xuất

### Option 1: Docker-First Approach (Khuyến nghị cho Local Development)

```
lumibase-starter/
├── docker/
│   ├── docker-compose.yml           # Core services
│   ├── docker-compose.prod.yml      # Production overrides
│   └── Dockerfile.custom            # Custom Directus image (nếu cần)
├── migrations/
│   ├── 001_initial_schema.sql       # Base schema (users table)
│   ├── 002_add_products.sql         # Example: Products collection
│   ├── 003_add_orders.sql           # Example: Orders collection
│   └── README.md                    # Migration guide
├── directus-snapshots/
│   ├── base-snapshot.yaml           # Directus schema export
│   ├── with-products.yaml           # With products collection
│   └── README.md                    # Snapshot guide
├── scripts/
│   ├── setup.sh                     # One-command setup
│   ├── migrate.sh                   # Run migrations
│   ├── snapshot-export.sh           # Export Directus schema
│   ├── snapshot-import.sh           # Import Directus schema
│   └── reset.sh                     # Reset everything
├── templates/
│   ├── .env.template                # Environment template
│   └── firebase-config.template.js  # Firebase config template
├── functions/                       # Firebase Cloud Functions
├── client/                          # Client integration examples
├── docs/                           # Documentation
├── .env.example
├── package.json
└── README.md
```

### Option 2: NPM Package Approach (Khuyến nghị cho Distribution)

```
@lumibase/starter/
├── bin/
│   └── lumibase.js                  # CLI tool
├── templates/
│   ├── docker-compose.yml
│   ├── migrations/
│   ├── functions/
│   └── client/
├── lib/
│   ├── setup.js                     # Setup logic
│   ├── migrate.js                   # Migration logic
│   └── config.js                    # Configuration
└── package.json
```

**Sử dụng:**
```bash
npx @lumibase/starter init my-project
cd my-project
npm run setup
```

### Option 3: Hybrid Approach (Tốt nhất cho cả hai)

Kết hợp cả hai: NPM package để init, Docker để run.

## 🎨 Chiến Lược Đóng Gói Chi Tiết

### 1. Database Migrations Strategy

**Vấn đề:** Directus tạo collections → cần sync với version control

**Giải pháp: Migration-First Approach**

```sql
-- migrations/001_initial_schema.sql
CREATE TABLE IF NOT EXISTS public.users (...);

-- migrations/002_add_products.sql
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2),
    created_by VARCHAR(128) REFERENCES public.users(firebase_uid),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Anyone can view products"
    ON public.products FOR SELECT
    USING (true);

CREATE POLICY "Authenticated users can create products"
    ON public.products FOR INSERT
    WITH CHECK (auth.uid() = created_by);
```

**Migration Script:**
```bash
#!/bin/bash
# scripts/migrate.sh

set -e

echo "🔄 Running database migrations..."

# Load environment
source .env

# Run migrations in order
for migration in migrations/*.sql; do
    echo "Running $migration..."
    docker-compose exec -T postgres psql \
        -U $DB_USER \
        -d $DB_NAME \
        -f /migrations/$(basename $migration)
done

echo "✅ Migrations completed!"
```

### 2. Directus Schema Management

**Vấn đề:** Directus schema không được version control mặc định

**Giải pháp: Directus Snapshots**

```bash
# Export Directus schema
npx directus schema snapshot ./directus-snapshots/my-schema.yaml

# Import Directus schema
npx directus schema apply ./directus-snapshots/my-schema.yaml
```

**Automated Snapshot Script:**
```bash
#!/bin/bash
# scripts/snapshot-export.sh

echo "📸 Exporting Directus schema..."

docker-compose exec directus npx directus schema snapshot \
    /directus/snapshots/schema-$(date +%Y%m%d-%H%M%S).yaml

echo "✅ Schema exported!"
```

### 3. One-Command Setup

```bash
#!/bin/bash
# scripts/setup.sh

set -e

echo "🚀 Setting up LumiBase..."

# 1. Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "❌ Docker required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node.js required"; exit 1; }

# 2. Copy environment template
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your credentials"
    exit 0
fi

# 3. Generate Directus keys if not set
if ! grep -q "DIRECTUS_KEY=" .env || [ -z "$(grep DIRECTUS_KEY= .env | cut -d= -f2)" ]; then
    echo "🔑 Generating Directus keys..."
    DIRECTUS_KEY=$(openssl rand -base64 32)
    DIRECTUS_SECRET=$(openssl rand -base64 32)
    sed -i "s/DIRECTUS_KEY=.*/DIRECTUS_KEY=$DIRECTUS_KEY/" .env
    sed -i "s/DIRECTUS_SECRET=.*/DIRECTUS_SECRET=$DIRECTUS_SECRET/" .env
fi

# 4. Start Docker services
echo "🐳 Starting Docker services..."
docker-compose up -d

# 5. Wait for services to be ready
echo "⏳ Waiting for services..."
sleep 10

# 6. Run migrations
echo "🔄 Running migrations..."
./scripts/migrate.sh

# 7. Import Directus snapshot (if exists)
if [ -f directus-snapshots/base-snapshot.yaml ]; then
    echo "📸 Importing Directus schema..."
    docker-compose exec directus npx directus schema apply \
        /directus/snapshots/base-snapshot.yaml
fi

echo "✅ Setup complete!"
echo "🌐 Directus: http://localhost:8055"
echo "🗄️  PostgreSQL: localhost:5432"
```

### 4. Resource Optimization

**Vấn đề:** Mỗi project clone lại tốn resources

**Giải pháp A: Shared PostgreSQL (Development)**

```yaml
# docker-compose.shared.yml
version: '3.8'

services:
  postgres-shared:
    image: postgres:15-alpine
    container_name: lumibase-postgres-shared
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres_shared_data:/var/lib/postgresql/data

volumes:
  postgres_shared_data:
```

Mỗi project tạo database riêng trong cùng PostgreSQL instance:

```bash
# scripts/create-project-db.sh
PROJECT_NAME=$1
docker exec lumibase-postgres-shared psql -U postgres -c "CREATE DATABASE ${PROJECT_NAME};"
```

**Giải pháp B: Directus Extensions (Advanced)**

Thay vì mỗi project một Directus, dùng Directus multi-tenancy:

```yaml
# docker-compose.yml
services:
  directus:
    environment:
      # Multi-project support
      DB_DATABASE: ${PROJECT_NAME}_db
```

**Giải pháp C: Cloud-Based (Production)**

- PostgreSQL: Supabase (free tier: 500MB)
- Directus: Railway.app / Render.com (free tier available)
- Firebase: Free tier (generous limits)

### 5. Pre-built Collections Package

**Tạo collection templates có thể import:**

```yaml
# directus-snapshots/ecommerce-base.yaml
version: 1
directus: 10.x.x
collections:
  - collection: products
    fields:
      - field: id
        type: uuid
        schema:
          is_primary_key: true
      - field: name
        type: string
        meta:
          required: true
      - field: price
        type: decimal
        meta:
          required: true
  - collection: orders
    fields:
      - field: id
        type: uuid
      - field: user_id
        type: string
      - field: total
        type: decimal
relations:
  - collection: orders
    field: user_id
    related_collection: users
```

**Import script:**
```bash
# scripts/import-template.sh
TEMPLATE=$1  # ecommerce, blog, saas, etc.

echo "📦 Importing $TEMPLATE template..."

# Import SQL migrations
./scripts/migrate.sh templates/$TEMPLATE/migrations

# Import Directus snapshot
docker-compose exec directus npx directus schema apply \
    /directus/snapshots/templates/$TEMPLATE.yaml

echo "✅ Template imported!"
```

## 📦 Distribution Strategy

### Strategy 1: GitHub Template Repository

```
https://github.com/yourusername/lumibase-starter
```

**Sử dụng:**
```bash
# Use GitHub template
gh repo create my-app --template yourusername/lumibase-starter

cd my-app
npm run setup
```

**Ưu điểm:**
- Dễ customize
- Full control
- Git history sạch

**Nhược điểm:**
- Phải manual update khi có version mới

### Strategy 2: NPM Package + CLI

```bash
npm install -g @lumibase/cli

lumibase init my-app --template ecommerce
cd my-app
lumibase start
```

**Ưu điểm:**
- Easy updates (`npm update`)
- Professional
- Multiple templates

**Nhược điểm:**
- Phức tạp hơn để maintain

### Strategy 3: Docker Image (All-in-One)

```bash
docker run -p 8055:8055 -p 5432:5432 \
    -e FIREBASE_PROJECT_ID=xxx \
    lumibase/starter:latest
```

**Ưu điểm:**
- Simplest setup
- Consistent environment

**Nhược điểm:**
- Khó customize
- Large image size

## 🎯 Recommended Approach

**Cho LumiBase, tôi khuyến nghị: Hybrid Strategy**

### Phase 1: GitHub Template (MVP)

1. Tạo GitHub template repository
2. Include:
   - Docker Compose setup
   - Migration scripts
   - Directus snapshots
   - Setup scripts
   - Pre-built templates (ecommerce, blog, saas)

### Phase 2: NPM CLI Tool

1. Tạo `@lumibase/cli` package
2. Features:
   ```bash
   lumibase init <project-name> --template <template>
   lumibase migrate
   lumibase snapshot export/import
   lumibase add-collection <name>
   ```

### Phase 3: Marketplace

1. Tạo template marketplace
2. Community contributions
3. Pre-built integrations (Stripe, SendGrid, etc.)

## 📋 Implementation Checklist

- [ ] Tạo migration system
- [ ] Setup Directus snapshot workflow
- [ ] Viết setup scripts (setup.sh, migrate.sh)
- [ ] Tạo collection templates (ecommerce, blog, saas)
- [ ] Document migration guide
- [ ] Tạo GitHub template repository
- [ ] (Optional) Build NPM CLI tool
- [ ] (Optional) Create Docker all-in-one image

## 🔄 Update Strategy

**Khi có version mới của LumiBase:**

```bash
# User updates
git remote add upstream https://github.com/yourusername/lumibase-starter
git fetch upstream
git merge upstream/main

# Resolve conflicts (mainly in .env, custom code)
# Migrations tự động chạy
./scripts/migrate.sh
```

## 💡 Best Practices

1. **Migrations are immutable**: Không sửa migration cũ, tạo migration mới
2. **Snapshot regularly**: Export Directus schema sau mỗi thay đổi lớn
3. **Environment-specific configs**: Dev, staging, production
4. **Seed data separately**: Không mix seed data với migrations
5. **Document custom changes**: Giúp merge updates dễ dàng

## 🎁 Bonus: Pre-built Templates

### Template: E-commerce
- Products, Categories, Orders, Cart
- Payment integration ready
- Inventory management

### Template: Blog/CMS
- Posts, Authors, Categories, Tags
- SEO fields
- Media library

### Template: SaaS
- Organizations, Teams, Subscriptions
- Role-based access
- Billing integration

### Template: Social Network
- Users, Posts, Comments, Likes
- Follow system
- Activity feed

