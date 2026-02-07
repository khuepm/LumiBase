# Test Environment Guide

This guide explains how to set up and use the isolated test environment for running tests.

## Overview

The test environment uses a separate Docker Compose configuration (`docker-compose.test.yml`) that runs on different ports to avoid conflicts with the development environment. This allows you to run tests without affecting your development data.

## Architecture

### Test Environment Components

- **PostgreSQL Test Database**: Runs on port `5433` (instead of `5432`)
- **Directus Test Instance**: Runs on port `8056` (instead of `8055`)
- **Isolated Network**: Uses `directus-test-network` (separate from dev network)
- **Separate Volumes**: Uses dedicated volumes for test data

### Port Mapping

| Service | Development Port | Test Port |
|---------|-----------------|-----------|
| PostgreSQL | 5432 | 5433 |
| Directus | 8055 | 8056 |

## Setup

### 1. Environment Variables

The test environment uses `.env.test` for configuration. Default values are provided in `docker-compose.test.yml`, so you can run tests without creating this file.

To customize test environment variables:

```bash
cp .env.test .env.test.local
# Edit .env.test.local with your test configuration
```

### 2. Start Test Environment

```bash
# Start test environment
npm run test:env:up

# Check status
npm run test:env:status

# View logs
npm run test:env:logs
```

### 3. Run Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:property

# Run tests with coverage
npm run test:coverage
```

### 4. Stop Test Environment

```bash
# Stop test environment (keeps data)
npm run test:env:down

# Stop and remove all data (clean slate)
npm run test:env:clean
```

## NPM Scripts

### Test Environment Management

- `npm run test:env:up` - Start test environment containers
- `npm run test:env:down` - Stop test environment containers
- `npm run test:env:clean` - Stop and remove all test data volumes
- `npm run test:env:logs` - View test environment logs
- `npm run test:env:status` - Check test environment status

### Running Tests

- `npm test` - Run all tests
- `npm run test:unit` - Run unit tests only
- `npm run test:integration` - Run integration tests only
- `npm run test:property` - Run property-based tests only
- `npm run test:coverage` - Run tests with coverage report
- `npm run test:with-env` - Start test env, run tests, then stop env

## Test Database

### Accessing Test Database

```bash
# Connect to test database
docker exec -it directus-postgres-test psql -U test_user -d test_db

# Run SQL queries
docker exec -it directus-postgres-test psql -U test_user -d test_db -c "SELECT * FROM users;"
```

### Reset Test Database

```bash
# Stop and clean test environment
npm run test:env:clean

# Start fresh test environment
npm run test:env:up
```

The database schema is automatically created from `init-scripts/` when the container starts.

## Test Directus Instance

### Accessing Test Directus

- **URL**: http://localhost:8056
- **Admin Email**: test@example.com (default)
- **Admin Password**: test_password (default)

### API Endpoints

- **Health Check**: http://localhost:8056/server/health
- **REST API**: http://localhost:8056/items/
- **GraphQL**: http://localhost:8056/graphql

## Running Tests in CI/CD

The test environment is designed to work in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Start test environment
  run: npm run test:env:up

- name: Wait for services
  run: sleep 10

- name: Run tests
  run: npm test

- name: Stop test environment
  run: npm run test:env:down
```

## Troubleshooting

### Port Conflicts

If ports 5433 or 8056 are already in use:

1. Edit `docker-compose.test.yml`
2. Change the port mappings:
   ```yaml
   ports:
     - "5434:5432"  # Use different port
   ```

### Database Connection Issues

Check if PostgreSQL is ready:

```bash
docker exec directus-postgres-test pg_isready -U test_user
```

### Directus Not Starting

Check Directus logs:

```bash
docker logs directus-cms-test
```

Common issues:
- Database not ready (wait for health check)
- Invalid environment variables
- Port already in use

### Clean Slate

If you encounter persistent issues:

```bash
# Remove everything and start fresh
npm run test:env:clean
docker system prune -f
npm run test:env:up
```

## Best Practices

### 1. Isolate Test Data

- Never use production credentials in test environment
- Use separate Firebase and Supabase test projects
- Keep test data minimal and focused

### 2. Clean Up After Tests

- Use `afterEach` hooks to clean up test data
- Reset database state between test suites
- Don't rely on test execution order

### 3. Use Test Fixtures

- Create reusable test data fixtures
- Use factories for generating test objects
- Keep fixtures in `tests/fixtures/` directory

### 4. Mock External Services

- Mock Firebase Authentication in unit tests
- Use Firebase Emulator for integration tests
- Mock Supabase API calls when appropriate

### 5. Parallel Testing

The test environment supports running multiple test suites in parallel:

```bash
# Run tests in parallel (Vitest default)
npm test

# Run tests sequentially if needed
vitest run --no-threads
```

## Integration with Development

### Running Both Environments

You can run both development and test environments simultaneously:

```bash
# Terminal 1: Development environment
docker-compose up

# Terminal 2: Test environment
npm run test:env:up
npm test
```

They use different ports and networks, so they won't conflict.

### Switching Between Environments

```bash
# Use development environment
export NODE_ENV=development
npm run seed-data

# Use test environment
export NODE_ENV=test
npm test
```

## Advanced Configuration

### Custom Test Database

To use a different database for specific tests:

```typescript
// tests/setup.ts
import { createClient } from '@supabase/supabase-js';

const testDbUrl = process.env.TEST_DB_URL || 'postgresql://test_user:test_password@localhost:5433/test_db';
const supabase = createClient(testDbUrl, process.env.SUPABASE_ANON_KEY);

export { supabase };
```

### Test-Specific Migrations

Place test-specific migrations in `init-scripts/test/`:

```sql
-- init-scripts/test/01-test-data.sql
INSERT INTO users (firebase_uid, email, display_name)
VALUES ('test-uid-1', 'test1@example.com', 'Test User 1');
```

Update `docker-compose.test.yml` to include test migrations:

```yaml
volumes:
  - ./init-scripts:/docker-entrypoint-initdb.d
  - ./init-scripts/test:/docker-entrypoint-initdb.d/test
```

## Related Documentation

- [Testing Procedures](./TESTING-PROCEDURES.md)
- [Database Reset Guide](./TASK-12.2-DATABASE-RESET-GUIDE.md)
- [Firebase Emulator Setup](./FIREBASE-EMULATOR-GUIDE.md)

## Support

If you encounter issues with the test environment:

1. Check the troubleshooting section above
2. Review test environment logs: `npm run test:env:logs`
3. Verify Docker is running: `docker ps`
4. Check port availability: `netstat -an | grep 5433`
