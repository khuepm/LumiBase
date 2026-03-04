---
inclusion: auto
---

# Technology Stack

## Core Technologies

- **Node.js**: 18+ (runtime environment)
- **TypeScript**: Type-safe development across all modules
- **PostgreSQL**: 15+ (via Supabase and Docker)
- **Docker**: Container orchestration for local development

## Backend Services

- **Firebase**: Authentication, Cloud Functions, Analytics
- **Supabase**: PostgreSQL database with auto-generated REST API
- **Directus**: v10+ headless CMS

## Testing Framework

- **Vitest**: Test runner for unit, integration, and property-based tests
- **fast-check**: Property-based testing library
- **Docker Compose**: Isolated test environment on separate ports

## Key Libraries

- `firebase-admin`: Server-side Firebase SDK
- `@supabase/supabase-js`: Supabase client library
- `firebase/auth`: Client-side Firebase authentication
- `pg`: PostgreSQL client for Node.js
- `jsonwebtoken`: JWT token handling

## Common Commands

### Development

```bash
# Start all services (PostgreSQL + Directus)
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Stop and remove all data
docker-compose down -v
```

### Testing

```bash
# Run all tests
npm test

# Run specific test types
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:property      # Property-based tests only

# Run with coverage
npm run test:coverage

# Test environment management
npm run test:env:up        # Start isolated test environment
npm run test:env:down      # Stop test environment
npm run test:env:clean     # Remove test data volumes
npm run test:env:status    # Check test environment status
```

### Firebase Functions

```bash
cd functions

# Install dependencies
npm install

# Build TypeScript
npm run build

# Deploy to Firebase
npm run deploy

# Test locally with emulator
npm run serve
```

### Database Management

```bash
# Seed sample data
./scripts/seed-data.sh        # Linux/Mac
.\scripts\seed-data.ps1       # Windows PowerShell
npx tsx scripts/seed-data.ts  # Cross-platform

# Access PostgreSQL shell
docker-compose exec postgres psql -U directus -d directus

# Verify database setup
./scripts/verify-database-setup.sh   # Linux/Mac
.\scripts\verify-database-setup.ps1  # Windows PowerShell
```

## Build System

- **TypeScript Compiler**: `tsc` for type checking and compilation
- **Firebase CLI**: Deployment and emulator management
- **Docker Compose**: Service orchestration
- **npm scripts**: Task automation

## Environment Configuration

All services require environment variables defined in `.env`:
- Firebase credentials (Project ID, API keys, service account)
- Supabase credentials (URL, anon key, service role key, JWT secret)
- Directus configuration (admin credentials, secrets)
- Database credentials (user, password, database name)

Never commit `.env` files - use `.env.example` as template.
