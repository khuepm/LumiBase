# ⚡ LumiBase Quick Start

> Get up and running in 5 minutes!

## 🚀 For End Users

### Step 1: Clone

```bash
git clone https://github.com/yourusername/lumibase-starter.git my-app
cd my-app
```

### Step 2: Setup

```bash
./scripts/setup.sh
```

Follow prompts to configure `.env`, then run again:

```bash
./scripts/setup.sh
```

### Step 3: Open Directus

```bash
open http://localhost:8055
```

Login with credentials from `.env`:
- Email: `DIRECTUS_ADMIN_EMAIL`
- Password: `DIRECTUS_ADMIN_PASSWORD`

### Step 4 (Optional): Add Template

```bash
./scripts/add-template.sh ecommerce
```

**Done! 🎉**

---

## 🛠️ For Developers

### Create New Collections

```bash
# 1. Create in Directus UI
open http://localhost:8055

# 2. Export schema
./scripts/snapshot-export.sh

# 3. Commit
git add directus-snapshots/
git commit -m "feat: add new collection"
```

### Add Custom Migration

```bash
# 1. Create migration file
cat > init-scripts/03-my-feature.sql << 'EOF'
CREATE TABLE IF NOT EXISTS public.my_table (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL
);
EOF

# 2. Run migration
./scripts/migrate.sh
```

### Share with Team

```bash
# Team members just need to:
git pull
./scripts/migrate.sh
./scripts/snapshot-import.sh directus-snapshots/base-snapshot.yaml
```

---

## 📦 Available Templates

### E-commerce
```bash
./scripts/add-template.sh ecommerce
```
Includes: Products, Categories, Orders, Cart

### Blog (Coming Soon)
```bash
./scripts/add-template.sh blog
```
Includes: Posts, Authors, Categories, Tags

### SaaS (Coming Soon)
```bash
./scripts/add-template.sh saas
```
Includes: Organizations, Teams, Subscriptions

---

## 🔧 Useful Commands

```bash
# View logs
docker-compose logs -f

# Restart services
docker-compose restart

# Stop services
docker-compose down

# Reset everything (⚠️ deletes data)
docker-compose down -v
./scripts/setup.sh

# Run migrations
./scripts/migrate.sh

# Export Directus schema
./scripts/snapshot-export.sh

# Import Directus schema
./scripts/snapshot-import.sh directus-snapshots/base-snapshot.yaml
```

---

## 🌐 Services

| Service | URL | Credentials |
|---------|-----|-------------|
| Directus CMS | http://localhost:8055 | From `.env` |
| PostgreSQL | localhost:5432 | From `.env` |

---

## 📚 Documentation

- [README.md](README.md) - Full documentation
- [PACKAGING-GUIDE.md](PACKAGING-GUIDE.md) - Packaging guide
- [docs/PACKAGING-ARCHITECTURE.md](docs/PACKAGING-ARCHITECTURE.md) - Architecture details
- [templates/ecommerce/README.md](templates/ecommerce/README.md) - E-commerce template

---

## 🐛 Troubleshooting

### Scripts not executable?
```bash
chmod +x scripts/*.sh
```

### Services not starting?
```bash
docker-compose down -v
docker-compose up -d
```

### Migration fails?
```bash
docker-compose logs postgres
```

### Need help?
Check [README.md](README.md) or create an issue on GitHub.

---

**Happy Building! 🚀**
