# GitHub Actions Workflows

This directory contains CI/CD workflows for automated testing and deployment.

## Workflows

### `test.yml` - Test Suite
Runs on every push and pull request to `main` and `develop` branches.

**What it does:**
- Runs unit, property, and integration tests
- Validates Docker configurations
- Checks TypeScript types
- Scans for security vulnerabilities
- Generates test coverage reports

**Required secrets:**
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CODECOV_TOKEN` (optional)

### `deploy-functions.yml` - Deploy Firebase Functions
Runs on push to `main` when functions code changes, or manually.

**What it does:**
- Builds Firebase Functions
- Runs function tests
- Deploys to Firebase

**Required secrets:**
- `FIREBASE_TOKEN`
- `FIREBASE_PROJECT_ID`

## Setup Instructions

See [CI/CD Setup Guide](../../docs/CI-CD-SETUP-GUIDE.md) for detailed setup instructions.

## Quick Start

1. Configure required secrets in GitHub repository settings
2. Push code to trigger workflows
3. Monitor workflow runs in the Actions tab

## Local Testing

Test workflows locally before pushing:

```bash
# Run all tests
npm test

# Validate Docker configs
docker-compose config

# Build and test functions
cd functions && npm run build && npm test
```
