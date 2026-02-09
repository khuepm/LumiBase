# Firebase Functions Configuration - Quick Reference

## ⚠️ Deprecation Notice

`firebase functions:config` will stop working in **March 2026**. Migrate now!

---

## Quick Migration

### 1. Export existing config (if you have it)

```bash
firebase experiments:enable legacyRuntimeConfigCommands
firebase functions:config:export
```

This creates `functions/.env` automatically.

### 2. Or create .env manually

```bash
cd functions
```

Create `functions/.env`:

```bash
SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3. Test locally

```bash
npm run serve
```

### 4. Set production secrets

```bash
firebase functions:secrets:set SUPABASE_URL
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
```

### 5. Deploy

```bash
npm run deploy
```

Done! ✅

---

## Command Comparison

| Task | Old (Deprecated) | New (Recommended) |
|------|------------------|-------------------|
| **Set config** | `firebase functions:config:set key="value"` | Create `functions/.env` file |
| **View config** | `firebase functions:config:get` | `cat functions/.env` |
| **Delete config** | `firebase functions:config:unset key` | Remove from `.env` file |
| **Production secrets** | `firebase functions:config:set` | `firebase functions:secrets:set KEY` |
| **List secrets** | `firebase functions:config:get` | `firebase functions:secrets:list` |

---

## Code Changes

### ✅ Already Compatible

Your code already supports both methods:

```typescript
const supabaseUrl = functions.config().supabase?.url || process.env.SUPABASE_URL || '';
const supabaseServiceKey = functions.config().supabase?.service_key || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
```

No code changes needed! Just update configuration method.

---

## Environment-Specific Setup

### Development

```bash
# Create .env file
cd functions
echo "SUPABASE_URL=https://dev.supabase.co" > .env
echo "SUPABASE_SERVICE_ROLE_KEY=dev-key" >> .env
```

### Staging

```bash
firebase use staging
firebase functions:secrets:set SUPABASE_URL
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
```

### Production

```bash
firebase use production
firebase functions:secrets:set SUPABASE_URL
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
```

---

## Troubleshooting

### Error: "functions.config() is deprecated"

✅ **Solution:** Already using environment variables fallback. Just create `.env` file.

### Error: "SUPABASE_URL is undefined"

✅ **Solution:** 
```bash
cd functions
cat .env  # Verify file exists and has correct values
```

### Error: "Secret not found"

✅ **Solution:**
```bash
firebase functions:secrets:set SUPABASE_URL
firebase functions:secrets:set SUPABASE_SERVICE_ROLE_KEY
```

### Local emulator not loading .env

✅ **Solution:** Ensure `.env` is in `functions/` directory (not root).

---

## Security Checklist

- [ ] `.env` is in `functions/.gitignore` ✅ (Already done)
- [ ] Never commit `.env` to Git
- [ ] Use secrets for production
- [ ] Rotate keys every 90 days
- [ ] Different keys for dev/staging/prod
- [ ] Monitor logs for unauthorized access

---

## Need Help?

📖 **Full Guide:** [Firebase Config Migration Guide](./FIREBASE-CONFIG-MIGRATION.md)

🔗 **Official Docs:** [Firebase Functions Environment Configuration](https://firebase.google.com/docs/functions/config-env)

---

**Last Updated:** 2026-02-09
