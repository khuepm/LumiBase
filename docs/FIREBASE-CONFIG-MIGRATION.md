# Firebase Functions Configuration Migration Guide

## ⚠️ Important Notice

Firebase has deprecated the `functions.config()` API and the Cloud Runtime Config service. **Deploys that rely on `functions.config()` will fail after March 2026.**

This guide shows you how to migrate from the legacy `functions:config` commands to modern environment variables and secrets.

## Migration Overview

### Old Method (Deprecated)
```bash
firebase functions:config:set supabase.url="https://xxxxx.supabase.co"
firebase functions:config:set supabase.service_key="eyJhbGc..."
```

### New Methods (Recommended)

**Method 1: Environment Variables** (Development)
```bash
# Create functions/.env file
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
```

**Method 2: Firebase Secrets** (Production)
```bash
firebase functions:secrets:set SUPABASE_URL
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
```

---

## Method 1: Environment Variables (Development)

### Step 1: Create .env File

```bash
cd functions
```

Create `functions/.env`:

```bash
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Step 2: Update .gitignore

Ensure `functions/.gitignore` includes:

```
.env
.env.*
!.env.example
```

### Step 3: Update Code

The code in `functions/src/index.ts` already supports environment variables:

```typescript
const supabaseUrl = functions.config().supabase?.url || process.env.SUPABASE_URL || '';
const supabaseServiceKey = functions.config().supabase?.service_key || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
```

### Step 4: Test Locally

```bash
cd functions
npm run serve
```

The Firebase emulator will automatically load `.env` file.

---

## Method 2: Firebase Secrets (Production)

### Step 1: Set Secrets

```bash
# Set Supabase URL
firebase functions:secrets:set SUPABASE_URL
# When prompted, enter: https://xxxxxxxxxxxxx.supabase.co

# Set Supabase Service Role Key
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
# When prompted, paste your service role key
```

### Step 2: Grant Access to Functions

```bash
# Grant access to specific function
firebase functions:secrets:access SUPABASE_URL --function=syncUserToSupabase

# Or grant access to all functions (recommended)
firebase functions:secrets:access SUPABASE_URL
firebase functions:secrets:access SUPABASE_SERVICE_ROLE_KEY
```

### Step 3: Update functions/package.json

Add secrets to your function configuration:

```json
{
  "engines": {
    "node": "18"
  },
  "main": "lib/index.js",
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^4.5.0",
    "@supabase/supabase-js": "^2.39.0"
  }
}
```

### Step 4: Deploy

```bash
cd functions
npm run deploy
```

Firebase will automatically inject secrets as environment variables.

### Step 5: Verify Secrets

```bash
# List all secrets
firebase functions:secrets:list

# View secret value (requires authentication)
firebase functions:secrets:access SUPABASE_URL
```

---

## Method 3: Migrate Existing Config (Legacy)

If you already have legacy config and want to migrate:

### Step 1: Export Existing Config

```bash
# Enable legacy commands temporarily
firebase experiments:enable legacyRuntimeConfigCommands

# Export to .env format
firebase functions:config:export
```

This creates `functions/.env` with your existing config.

### Step 2: Review and Clean Up

Review `functions/.env` and ensure it has the correct format:

```bash
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
```

### Step 3: Remove Legacy Config (Optional)

```bash
# Unset legacy config
firebase functions:config:unset supabase
```

### Step 4: Test and Deploy

```bash
# Test locally
npm run serve

# Deploy to production
npm run deploy
```

---

## Comparison Table

| Feature | Legacy Config | Environment Variables | Firebase Secrets |
|---------|--------------|----------------------|------------------|
| **Use Case** | Deprecated | Development | Production |
| **Security** | ⚠️ Medium | ⚠️ Medium | ✅ High |
| **Local Testing** | ✅ Yes | ✅ Yes | ⚠️ Limited |
| **Version Control** | ❌ No | ❌ No | ✅ Yes (encrypted) |
| **Rotation** | ⚠️ Manual | ⚠️ Manual | ✅ Easy |
| **Expiration** | ⚠️ March 2026 | ✅ Supported | ✅ Supported |
| **Cost** | Free | Free | Free |

---

## Best Practices

### 1. Use Different Methods for Different Environments

```bash
# Development: .env file
cd functions
echo "SUPABASE_URL=https://dev.supabase.co" > .env

# Production: Firebase Secrets
firebase use production
firebase functions:secrets:set SUPABASE_URL
```

### 2. Never Commit Secrets

Ensure `.gitignore` includes:

```
.env
.env.*
!.env.example
.runtimeconfig.json
```

### 3. Create .env.example Template

Create `functions/.env.example`:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
```

### 4. Rotate Secrets Regularly

```bash
# Update secret value
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY

# Deploy to apply changes
firebase deploy --only functions
```

### 5. Use Secret Versions

```bash
# View secret versions
firebase functions:secrets:versions SUPABASE_URL

# Rollback to previous version if needed
firebase functions:secrets:access SUPABASE_URL@1
```

---

## Troubleshooting

### Error: "functions.config() is deprecated"

**Solution:** Update your code to use environment variables:

```typescript
// Old (deprecated)
const url = functions.config().supabase.url;

// New (recommended)
const url = process.env.SUPABASE_URL || '';
```

### Error: "Secret not found"

**Solution:** Ensure secret is set and accessible:

```bash
# Set secret
firebase functions:secrets:set SUPABASE_URL

# Grant access
firebase functions:secrets:access SUPABASE_URL

# Verify
firebase functions:secrets:list
```

### Error: ".env file not loaded"

**Solution:** Ensure `.env` is in `functions/` directory:

```bash
cd functions
ls -la .env  # Should exist
cat .env     # Should contain variables
```

### Error: "Permission denied accessing secret"

**Solution:** Grant IAM permissions:

```bash
# Grant Secret Manager access
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:YOUR_PROJECT_ID@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Migration Checklist

- [ ] Export existing config: `firebase functions:config:export`
- [ ] Create `functions/.env` file
- [ ] Add `.env` to `.gitignore`
- [ ] Create `functions/.env.example` template
- [ ] Test locally: `npm run serve`
- [ ] Set production secrets: `firebase functions:secrets:set`
- [ ] Deploy: `npm run deploy`
- [ ] Verify functions work correctly
- [ ] Remove legacy config: `firebase functions:config:unset`
- [ ] Update documentation
- [ ] Notify team members

---

## Additional Resources

- [Firebase Functions Environment Configuration](https://firebase.google.com/docs/functions/config-env)
- [Migrating from functions.config()](https://firebase.google.com/docs/functions/config-env#migrate-config)
- [Firebase Secrets Manager](https://firebase.google.com/docs/functions/config-env#secret-manager)
- [Google Cloud Secret Manager](https://cloud.google.com/secret-manager/docs)

---

**Last Updated:** 2026-02-09  
**Migration Deadline:** March 2026
