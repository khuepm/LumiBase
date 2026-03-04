#!/bin/bash

# LumiBase Setup Script
# One-command setup for new projects

set -e

echo "🚀 LumiBase Setup Starting..."
echo "================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed${NC}"
    echo "Please install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed${NC}"
    echo "Please install Node.js: https://nodejs.org/"
    exit 1
fi

echo -e "${GREEN}✅ Prerequisites check passed${NC}"

# Check if .env exists
if [ ! -f .env ]; then
    echo ""
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    
    echo -e "${YELLOW}⚠️  IMPORTANT: Please edit .env file with your credentials:${NC}"
    echo "   - Firebase credentials"
    echo "   - Supabase credentials"
    echo "   - Database passwords"
    echo ""
    echo "Run this script again after updating .env"
    exit 0
fi

# Load environment variables
source .env

# Generate Directus keys if not set
if [ -z "$DIRECTUS_KEY" ] || [ "$DIRECTUS_KEY" = "your-random-key-here" ]; then
    echo ""
    echo "🔑 Generating Directus keys..."
    DIRECTUS_KEY=$(openssl rand -base64 32)
    DIRECTUS_SECRET=$(openssl rand -base64 32)
    
    # Update .env file
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s|DIRECTUS_KEY=.*|DIRECTUS_KEY=$DIRECTUS_KEY|" .env
        sed -i '' "s|DIRECTUS_SECRET=.*|DIRECTUS_SECRET=$DIRECTUS_SECRET|" .env
    else
        # Linux
        sed -i "s|DIRECTUS_KEY=.*|DIRECTUS_KEY=$DIRECTUS_KEY|" .env
        sed -i "s|DIRECTUS_SECRET=.*|DIRECTUS_SECRET=$DIRECTUS_SECRET|" .env
    fi
    
    echo -e "${GREEN}✅ Directus keys generated${NC}"
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Start Docker services
echo ""
echo "🐳 Starting Docker services..."
docker-compose down 2>/dev/null || true
docker-compose up -d

# Wait for services to be ready
echo ""
echo "⏳ Waiting for services to be ready..."
echo "   This may take 30-60 seconds..."

# Wait for PostgreSQL
for i in {1..30}; do
    if docker-compose exec -T postgres pg_isready -U $DB_USER &>/dev/null; then
        echo -e "${GREEN}✅ PostgreSQL is ready${NC}"
        break
    fi
    echo -n "."
    sleep 2
done

# Wait for Directus
for i in {1..30}; do
    if curl -s http://localhost:8055/server/health &>/dev/null; then
        echo -e "${GREEN}✅ Directus is ready${NC}"
        break
    fi
    echo -n "."
    sleep 2
done

# Run migrations
echo ""
echo "🔄 Running database migrations..."
if [ -x ./scripts/migrate.sh ]; then
    ./scripts/migrate.sh
else
    echo -e "${YELLOW}⚠️  migrate.sh not found or not executable${NC}"
fi

# Import Directus snapshot if exists
if [ -f directus-snapshots/base-snapshot.yaml ]; then
    echo ""
    echo "📸 Importing Directus schema..."
    docker-compose exec -T directus npx directus schema apply \
        /directus/snapshots/base-snapshot.yaml 2>/dev/null || \
        echo -e "${YELLOW}⚠️  Could not import snapshot (this is OK for first run)${NC}"
fi

# Setup complete
echo ""
echo "================================"
echo -e "${GREEN}✅ Setup Complete!${NC}"
echo ""
echo "🌐 Services:"
echo "   Directus CMS: http://localhost:8055"
echo "   PostgreSQL:   localhost:5432"
echo ""
echo "🔐 Directus Login:"
echo "   Email:    $DIRECTUS_ADMIN_EMAIL"
echo "   Password: $DIRECTUS_ADMIN_PASSWORD"
echo ""
echo "📚 Next Steps:"
echo "   1. Open Directus: http://localhost:8055"
echo "   2. Login with admin credentials"
echo "   3. Start building your collections!"
echo ""
echo "🛠️  Useful Commands:"
echo "   docker-compose logs -f     # View logs"
echo "   docker-compose down        # Stop services"
echo "   docker-compose restart     # Restart services"
echo "   ./scripts/migrate.sh       # Run migrations"
echo ""
