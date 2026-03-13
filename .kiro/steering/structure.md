---
inclusion: auto
---

# Project Structure

## Root Directory Layout

```
LumiBase/
├── .kiro/                  # Kiro AI assistant configuration
│   ├── specs/             # Feature specifications and implementation plans
│   └── steering/          # AI assistant guidance documents
├── client/                # Client-side authentication integration
├── functions/             # Firebase Cloud Functions
├── init-scripts/          # Database initialization SQL scripts
├── scripts/               # Development utility scripts
├── tests/                 # Test suites
├── docs/                  # Documentation
└── [config files]         # Root-level configuration
```

## Module Details

### `/client` - Client-Side Integration

Contains TypeScript modules for client-side Firebase and Supabase integration:
- `auth.ts`: Authentication logic (Google OAuth, JWT management, Supabase client)
- `tests/`: Client-side unit tests
- Demonstrates how to integrate Firebase Auth with Supabase in frontend applications

### `/functions` - Firebase Cloud Functions

Server-side functions that sync user data between Firebase and Supabase:
- `src/index.ts`: Cloud Functions (onCreate, onDelete triggers)
- `test/`: Cloud Function tests (unit and property-based)
- Deployed to Firebase, runs on user authentication events

### `/init-scripts` - Database Initialization

SQL scripts executed when PostgreSQL container starts:
- `01-create-schema.sql`: Creates users table, indexes, triggers
- `02-setup-rls.sql`: Configures Row Level Security policies
- Automatically run by Docker on first startup

### `/scripts` - Development Utilities

Bash and PowerShell scripts for common tasks:
- `verify-database-setup.sh/.ps1`: Automated database verification
- `seed-data.sh/.ps1/.ts`: Insert sample users for testing
- `reset-db.sh/.ps1`: Reset database to clean state

### `/tests` - Test Suites

Organized by test type:
- `unit/`: Fast, isolated tests (schema validation, config parsing)
- `integration/`: Tests requiring external services (RLS policies, JWT verification)
- `property/`: Property-based tests using fast-check (schema integrity, token validation)
- `setup.ts`: Shared test configuration

### `/docs` - Documentation

Comprehensive guides organized by topic:
- Setup guides (Firebase, Supabase, Docker)
- Testing procedures and environment guides
- Task summaries and checkpoint reports
- CI/CD and deployment procedures

## Configuration Files

### Root Level

- `package.json`: Project dependencies and npm scripts
- `vitest.config.ts`: Test runner configuration
- `docker-compose.yml`: Development environment services
- `docker-compose.test.yml`: Isolated test environment
- `firebase.json`: Firebase project configuration
- `.firebaserc`: Firebase project selection
- `.env`: Environment variables (never commit)
- `.env.example`: Environment template

### Module Level

- `client/package.json`: Client-side dependencies
- `client/vitest.config.ts`: Client test configuration
- `functions/package.json`: Cloud Functions dependencies
- `functions/tsconfig.json`: TypeScript config for functions

## Key Conventions

### File Naming

- TypeScript files: `kebab-case.ts`
- Test files: `*.test.ts` (unit/integration) or `*.property.test.ts` (property-based)
- SQL scripts: Numbered prefix for execution order (`01-`, `02-`)
- Documentation: `UPPERCASE-WITH-DASHES.md`

### Import Paths

- Use relative imports within modules
- External dependencies imported from `node_modules`
- Environment variables accessed via `process.env`

### Database Schema

- All tables in `public` schema
- Primary key: `firebase_uid` (VARCHAR)
- Timestamps: `created_at`, `updated_at` (auto-managed by triggers)
- RLS policies enforce user-level data isolation

### Error Handling

- Custom error classes for different error types (AuthenticationError, DataFetchError)
- Comprehensive logging with structured data
- Retry logic for transient failures (Cloud Functions)
- Never throw errors that would block user creation

### Testing Patterns

- Test environment uses separate ports (5433 for DB, 8056 for Directus)
- Property-based tests validate universal invariants
- Integration tests require Docker services running
- Mock external services in unit tests
