# Quick Test Environment Reference

## Quick Start

```bash
# 1. Start test environment
npm run test:env:up

# 2. Run tests
npm test

# 3. Stop test environment
npm run test:env:down
```

## Common Commands

| Command | Description |
|---------|-------------|
| `npm run test:env:up` | Start test environment |
| `npm run test:env:down` | Stop test environment |
| `npm run test:env:clean` | Stop and remove all test data |
| `npm run test:env:status` | Check test environment status |
| `npm run test:env:logs` | View test environment logs |
| `npm run test:with-env` | Start env, run tests, stop env |

## Test Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests only |
| `npm run test:property` | Run property-based tests only |
| `npm run test:coverage` | Run tests with coverage |

## Test Environment Details

### Ports

| Service | Development | Test |
|---------|------------|------|
| PostgreSQL | 5432 | 5433 |
| Directus | 8055 | 8056 |

### Default Credentials

**Database:**
- User: `test_user`
- Password: `test_password`
- Database: `test_db`

**Directus:**
- Email: `test@example.com`
- Password: `test_password`
- URL: http://localhost:8056

### URLs

- **Directus Admin**: http://localhost:8056/admin
- **Directus API**: http://localhost:8056/items/
- **Directus Health**: http://localhost:8056/server/health

## Database Access

```bash
# Connect to test database
docker exec -it directus-postgres-test psql -U test_user -d test_db

# Run SQL query
docker exec -it directus-postgres-test psql -U test_user -d test_db -c "SELECT * FROM users;"

# View database logs
docker logs directus-postgres-test
```

## Troubleshooting

### Services not starting

```bash
# Check Docker is running
docker ps

# Check port availability
netstat -an | grep 5433
netstat -an | grep 8056

# View logs
npm run test:env:logs
```

### Clean slate

```bash
# Remove everything and start fresh
npm run test:env:clean
docker system prune -f
npm run test:env:up
```

### Port conflicts

Edit `docker-compose.test.yml` and change port mappings:

```yaml
ports:
  - "5434:5432"  # Use different port
```

## CI/CD Integration

```yaml
# GitHub Actions example
- name: Start test environment
  run: npm run test:env:up

- name: Wait for services
  run: sleep 10

- name: Run tests
  run: npm test

- name: Stop test environment
  run: npm run test:env:down
```

## Environment Variables

Test environment uses `.env.test` or defaults from `docker-compose.test.yml`.

To customize:

```bash
cp .env.test .env.test.local
# Edit .env.test.local
```

## Related Documentation

- [Test Environment Guide](./TEST-ENVIRONMENT-GUIDE.md) - Comprehensive guide
- [Testing Procedures](./TESTING-PROCEDURES.md) - Testing best practices
- [Database Reset Guide](./TASK-12.2-DATABASE-RESET-GUIDE.md) - Database management
