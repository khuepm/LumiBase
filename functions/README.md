# Firebase Cloud Functions

This directory contains Firebase Cloud Functions for syncing user data between Firebase Authentication and Supabase database.

## Functions

### syncUserToSupabase
Triggered when a new user is created in Firebase Authentication. Automatically syncs user data to the Supabase `public.users` table.

**Trigger:** `onCreate` (Firebase Auth)

**Data synced:**
- `firebase_uid` - User's Firebase UID
- `email` - User's email address
- `display_name` - User's display name (optional)
- `photo_url` - User's photo URL (optional)
- `updated_at` - Timestamp of last update

### deleteUserFromSupabase
Triggered when a user is deleted from Firebase Authentication. Removes the corresponding user record from Supabase.

**Trigger:** `onDelete` (Firebase Auth)

## Setup

### Prerequisites
- Node.js 18 or higher
- Firebase CLI installed globally: `npm install -g firebase-tools`
- Firebase project created
- Supabase project created

### Configuration

1. **Set Firebase project:**
   ```bash
   firebase use <your-project-id>
   ```

2. **Configure Supabase credentials:**
   ```bash
   firebase functions:config:set supabase.url="https://xxxxx.supabase.co"
   firebase functions:config:set supabase.service_key="your-service-role-key"
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

### Development

**Build TypeScript:**
```bash
npm run build
```

**Watch mode (auto-rebuild on changes):**
```bash
npm run build:watch
```

**Run locally with Firebase Emulator:**
```bash
npm run serve
```

**Test functions interactively:**
```bash
npm run shell
```

### Deployment

**Deploy all functions:**
```bash
npm run deploy
```

**Deploy specific function:**
```bash
firebase deploy --only functions:syncUserToSupabase
```

**View logs:**
```bash
npm run logs
```

Or for specific function:
```bash
firebase functions:log --only syncUserToSupabase
```

## Testing

### Local Testing with Emulator

1. **Start the Firebase emulator:**
   ```bash
   npm run serve
   ```

2. **The emulator will run on:**
   - Functions: http://localhost:5001
   - Auth: http://localhost:9099
   - Emulator UI: http://localhost:4000

3. **Create a test user in the Auth emulator to trigger the function**

### Running Tests with Emulator

**Run all tests with emulator:**
```bash
npm run test:emulator
```

**Run integration tests with emulator:**
```bash
npm run test:integration:emulator
```

**Run tests manually with emulator running:**
```bash
# Terminal 1: Start emulator
npm run serve

# Terminal 2: Run tests
export FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
npm test
```

**Debug mode with VS Code:**
```bash
npm run serve:debug
```

Then attach VS Code debugger (F5) to debug functions with breakpoints.

### Environment Variables for Local Testing

Create a `functions/.runtimeconfig.json` file (not committed to Git):

```json
{
  "supabase": {
    "url": "https://xxxxx.supabase.co",
    "service_key": "your-service-role-key"
  }
}
```

Or use environment variables:

```bash
export SUPABASE_URL=https://xxxxx.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Comprehensive Testing Guide

For detailed information about testing with Firebase Emulator, see:
- [Firebase Emulator Guide](../docs/FIREBASE-EMULATOR-GUIDE.md)
- [Test Environment Guide](../docs/TEST-ENVIRONMENT-GUIDE.md)

## Error Handling

The functions include comprehensive error handling:

- **Duplicate email errors**: Handled via `upsert` operation
- **Network errors**: Logged but don't block user creation
- **Invalid credentials**: Logged with clear error messages
- **Timeout protection**: Functions are designed to complete within 5 seconds

## Monitoring

Monitor function execution in the Firebase Console:
- Functions > Dashboard
- Functions > Logs
- Functions > Health

Key metrics to watch:
- Execution time (should be < 5 seconds)
- Error rate
- Invocation count

## Troubleshooting

**Function not triggering:**
- Verify Firebase Auth is enabled
- Check function deployment status: `firebase functions:list`
- Review logs: `npm run logs`

**Supabase connection errors:**
- Verify Supabase URL and service key are correct
- Check Supabase project is active
- Verify network connectivity from Firebase

**TypeScript compilation errors:**
- Run `npm run build` to see detailed errors
- Ensure all dependencies are installed
- Check `tsconfig.json` configuration

## Security Notes

- Never commit `.env` files or credentials to Git
- Use Firebase Functions config for production secrets
- Service role key bypasses RLS - use carefully
- Validate all user input before database operations
- Monitor function logs for suspicious activity
