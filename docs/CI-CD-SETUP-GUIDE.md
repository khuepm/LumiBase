# CI/CD Pipeline Setup Guide

## Overview

This project uses GitHub Actions for continuous integration and deployment. The CI/CD pipeline automatically runs tests, validates configurations, and deploys Firebase Functions when changes are pushed to the repository.

## Workflows

### 1. Test Suite (`test.yml`)

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

**Jobs:**

#### Test Job
Runs all test suites with a PostgreSQL service container:

- **Unit Tests**: Tests individual components and configurations
- **Property Tests**: Runs property-based tests with 100 iterations
- **Integration Tests**: Tests interactions between services
- **Coverage**: Generates test coverage reports and uploads to Codecov

**Environment:**
- Ubuntu latest
- Node.js 18
- PostgreSQL 15 (service container)

**Steps:**
1. Checkout code
2. Setup Node.js with npm cache
3. Install dependencies (`npm ci`)
4. Setup test environment variables
5. Run database migrations
6. Execute test suites
7. Generate and upload coverage reports

#### Lint Job
Validates code quality and security:

- TypeScript type checking
- Security vulnerability scanning with `npm audit`

#### Docker Job
Validates Docker configurations:

- Validates `docker-compose.yml` syntax
- Validates `docker-compose.test.yml` syntax
- Tests Docker services startup

### 2. Deploy Firebase Functions (`deploy-functions.yml`)

**Triggers:**
- Push to `main` branch (only when `functions/**` changes)
- Manual workflow dispatch

**Steps:**
1. Checkout code
2. Setup Node.js
3. Install Firebase CLI
4. Install function dependencies
5. Build functions
6. Run function tests
7. Deploy to Firebase

## Required Secrets

Configure these secrets in your GitHub repository settings (`Settings > Secrets and variables > Actions`):

### For Test Workflow

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `SUPABASE_URL` | Your Supabase project URL | Supabase Dashboard > Settings > API |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | Supabase Dashboard > Settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Supabase Dashboard > Settings > API |
| `CODECOV_TOKEN` | Codecov upload token (optional) | codecov.io > Repository Settings |

### For Deploy Functions Workflow

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `FIREBASE_TOKEN` | Firebase CI token | Run `firebase login:ci` locally |
| `FIREBASE_PROJECT_ID` | Your Firebase project ID | Firebase Console > Project Settings |

## Setting Up Secrets

### 1. Supabase Secrets

```bash
# Get your Supabase credentials from the dashboard
# Navigate to: https://app.supabase.com/project/YOUR_PROJECT/settings/api

# Add to GitHub:
# Settings > Secrets and variables > Actions > New repository secret
```

### 2. Firebase Token

```bash
# Login to Firebase CLI
firebase login:ci

# Copy the token that is displayed
# Add it as FIREBASE_TOKEN secret in GitHub
```

### 3. Codecov Token (Optional)

```bash
# Sign up at https://codecov.io
# Add your repository
# Copy the upload token
# Add it as CODECOV_TOKEN secret in GitHub
```

## Local Testing

Before pushing changes, test the workflows locally:

### Test the Test Suite

```bash
# Start test environment
npm run test:env:up

# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:property
npm run test:integration

# Generate coverage
npm run test:coverage

# Stop test environment
npm run test:env:down
```

### Test Docker Configuration

```bash
# Validate docker-compose files
docker-compose config
docker-compose -f docker-compose.test.yml config

# Test startup
docker-compose -f docker-compose.test.yml up -d
docker-compose -f docker-compose.test.yml ps
docker-compose -f docker-compose.test.yml down -v
```

### Test Firebase Functions

```bash
cd functions

# Install dependencies
npm install

# Build functions
npm run build

# Run tests
npm test

# Test deployment (dry run)
firebase deploy --only functions --debug
```

## Workflow Status Badges

Add these badges to your README.md to show workflow status:

```markdown
![Test Suite](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Test%20Suite/badge.svg)
![Deploy Functions](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Deploy%20Firebase%20Functions/badge.svg)
[![codecov](https://codecov.io/gh/YOUR_USERNAME/YOUR_REPO/branch/main/graph/badge.svg)](https://codecov.io/gh/YOUR_USERNAME/YOUR_REPO)
```

## Troubleshooting

### Tests Failing in CI but Passing Locally

**Possible causes:**
- Environment variables not set correctly
- Database migrations not applied
- Service containers not ready

**Solutions:**
1. Check GitHub Actions logs for specific errors
2. Verify all required secrets are configured
3. Ensure database migrations are in `init-scripts/` directory
4. Add health checks to service containers

### Firebase Deployment Failing

**Possible causes:**
- Invalid Firebase token
- Insufficient permissions
- Build errors

**Solutions:**
1. Regenerate Firebase token: `firebase login:ci`
2. Check Firebase project permissions
3. Test build locally: `cd functions && npm run build`
4. Review Firebase Functions logs

### Coverage Upload Failing

**Possible causes:**
- Invalid Codecov token
- Coverage files not generated

**Solutions:**
1. Verify CODECOV_TOKEN secret is set
2. Check coverage files exist: `ls -la coverage/`
3. Set `fail_ci_if_error: false` to make it non-blocking

## Best Practices

### 1. Branch Protection Rules

Configure branch protection for `main`:
- Require pull request reviews
- Require status checks to pass (Test Suite)
- Require branches to be up to date

### 2. Test Coverage Goals

- Maintain minimum 80% code coverage
- Review coverage reports in pull requests
- Add tests for new features

### 3. Deployment Strategy

- Deploy to staging environment first (add staging workflow)
- Use manual approval for production deployments
- Monitor Firebase Functions logs after deployment

### 4. Security

- Rotate secrets regularly
- Use least privilege for service accounts
- Enable Dependabot for dependency updates
- Review security audit results

## Monitoring

### GitHub Actions

Monitor workflow runs:
- Navigate to `Actions` tab in GitHub
- View workflow history and logs
- Set up notifications for failures

### Firebase Functions

Monitor function execution:
```bash
# View logs
firebase functions:log

# View specific function
firebase functions:log --only syncUserToSupabase
```

### Test Coverage

View coverage reports:
- Codecov dashboard: https://codecov.io/gh/YOUR_USERNAME/YOUR_REPO
- Local coverage report: `npm run test:coverage` then open `coverage/index.html`

## Extending the Pipeline

### Adding New Test Suites

1. Add test script to `package.json`:
```json
"test:e2e": "vitest run tests/e2e"
```

2. Add step to `.github/workflows/test.yml`:
```yaml
- name: Run E2E tests
  run: npm run test:e2e
```

### Adding Deployment Environments

Create separate workflows for staging and production:

```yaml
# .github/workflows/deploy-staging.yml
on:
  push:
    branches: [ develop ]

# .github/workflows/deploy-production.yml
on:
  push:
    branches: [ main ]
  workflow_dispatch:
```

### Adding Code Quality Checks

Add linting and formatting:

```yaml
- name: Run ESLint
  run: npm run lint

- name: Check formatting
  run: npm run format:check
```

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Firebase CI/CD Documentation](https://firebase.google.com/docs/cli#cli-ci-systems)
- [Codecov Documentation](https://docs.codecov.com/)
- [Vitest Documentation](https://vitest.dev/)
