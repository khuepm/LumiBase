# Firebase Authentication Configuration Guide

This guide provides detailed instructions for configuring Firebase Authentication providers for LumiBase.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Creating a Firebase Project](#creating-a-firebase-project)
- [Enabling Google OAuth Provider](#enabling-google-oauth-provider)
- [Enabling Email/Password Authentication](#enabling-emailpassword-authentication)
- [Enabling Firebase Analytics](#enabling-firebase-analytics)
- [Downloading Service Account Credentials](#downloading-service-account-credentials)
- [Configuring Firebase for Cloud Functions](#configuring-firebase-for-cloud-functions)
- [Testing Authentication](#testing-authentication)
- [Troubleshooting](#troubleshooting)
- [Security Best Practices](#security-best-practices)

## Prerequisites

Before you begin, ensure you have:

- A Google account
- Firebase CLI installed (`npm install -g firebase-tools`)
- Access to Firebase Console
- Basic understanding of OAuth 2.0 and JWT tokens

## Creating a Firebase Project

### Step 1: Access Firebase Console

1. Navigate to [Firebase Console](https://console.firebase.google.com/)
2. Sign in with your Google account

### Step 2: Create New Project

1. Click **Add project** button
2. Enter your project name (e.g., "LumiBase" or "MyApp")
   - Project names must be unique across Firebase
   - You can use letters, numbers, spaces, and hyphens
3. Click **Continue**

### Step 3: Configure Google Analytics (Optional)

1. Toggle **Enable Google Analytics for this project**
   - Recommended for production apps
   - Provides insights into user behavior
   - Helps debug authentication issues
2. Click **Continue**

### Step 4: Configure Analytics Account

If you enabled Analytics:

1. Select an existing Google Analytics account or create a new one
2. Configure Analytics settings:
   - **Account name**: Your organization name
   - **Analytics location**: Select your region (affects data storage)
   - **Data sharing settings**: Configure as needed
3. Accept the terms and conditions
4. Click **Create project**

### Step 5: Wait for Project Creation

Firebase will set up your project (usually takes 30-60 seconds). Once complete, click **Continue**.

## Enabling Google OAuth Provider

Google OAuth allows users to sign in with their Google accounts.

### Step 1: Navigate to Authentication

1. In Firebase Console, click **Authentication** in the left sidebar
2. Click **Get started** if this is your first time
3. Click on the **Sign-in method** tab

### Step 2: Enable Google Provider

1. Find **Google** in the list of providers
2. Click on **Google** to open configuration
3. Toggle the **Enable** switch to ON

### Step 3: Configure OAuth Consent Screen

1. **Project support email**: Select your email from dropdown
   - This email will be shown to users during sign-in
   - Must be a verified email in your Google account

2. **Project public-facing name**: Enter your app name
   - This is what users see during Google sign-in
   - Example: "LumiBase", "My Awesome App"
   - Keep it short and recognizable

3. (Optional) **Project logo**: Upload a logo image
   - Recommended size: 120x120 pixels
   - Formats: PNG, JPG, GIF
   - Max file size: 1MB

4. Click **Save**

### Step 4: Configure Authorized Domains

For production apps, you need to authorize domains:

1. Scroll down to **Authorized domains**
2. Click **Add domain**
3. Enter your domain (e.g., `myapp.com`)
4. For local development, `localhost` is pre-authorized

### Step 5: Get OAuth Client ID (Optional)

For advanced configurations:

1. Click **Web SDK configuration**
2. Copy the **Web client ID** and **Web client secret**
3. Store these securely if needed for custom OAuth flows

### Important Notes

- **Development**: Google OAuth works immediately on `localhost`
- **Production**: You must verify domain ownership
- **OAuth Consent Screen**: Users see this when signing in
- **Scopes**: Firebase requests basic profile and email by default

## Enabling Email/Password Authentication

Email/Password authentication allows users to create accounts with email and password.

### Step 1: Navigate to Sign-in Methods

1. In Firebase Console, go to **Authentication** → **Sign-in method**
2. Find **Email/Password** in the providers list

### Step 2: Enable Email/Password

1. Click on **Email/Password** provider
2. Toggle the **Enable** switch to ON
3. You'll see two options:
   - **Email/Password**: Traditional email and password sign-in
   - **Email link (passwordless sign-in)**: Users sign in via email link

### Step 3: Configure Email/Password Settings

1. **Enable Email/Password**: Toggle ON (required)
2. **Enable Email link**: Toggle ON if you want passwordless sign-in (optional)

### Step 4: Configure Email Verification (Recommended)

1. Go to **Authentication** → **Templates** tab
2. Click on **Email address verification**
3. Customize the email template:
   - **From name**: Your app name
   - **Reply-to email**: Your support email
   - **Subject**: Customize the subject line
   - **Body**: Customize the email content
4. Click **Save**

### Step 5: Configure Password Requirements

Firebase has default password requirements:
- Minimum 6 characters
- No maximum length limit
- No complexity requirements by default

For stronger security, implement client-side validation:

```typescript
// Example password validation
function validatePassword(password: string): boolean {
  const minLength = 8;
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  
  return password.length >= minLength &&
         hasUpperCase &&
         hasLowerCase &&
         hasNumbers &&
         hasSpecialChar;
}
```

### Step 6: Configure Password Reset Email

1. Go to **Authentication** → **Templates** tab
2. Click on **Password reset**
3. Customize the email template
4. Click **Save**

### Important Notes

- **Email Verification**: Highly recommended for production
- **Password Strength**: Implement client-side validation
- **Rate Limiting**: Firebase automatically rate-limits authentication attempts
- **Account Enumeration**: Firebase prevents email enumeration attacks

## Enabling Firebase Analytics

Firebase Analytics provides insights into user behavior and authentication events.

### Step 1: Check Analytics Status

1. Go to **Project Settings** (gear icon) → **Integrations** tab
2. Find **Google Analytics** section

### Step 2: Enable Analytics

If not already enabled:

1. Click **Enable** button in Google Analytics section
2. Choose an option:
   - **Use an existing Google Analytics account**: Select from dropdown
   - **Create a new account**: Enter account name

### Step 3: Configure Analytics Settings

1. **Analytics location**: Select your region
   - Affects where data is stored
   - Choose closest to your users
   - Cannot be changed later

2. **Data sharing settings**: Configure as needed
   - Google products & services
   - Benchmarking
   - Technical support
   - Account specialists

3. Accept Google Analytics terms
4. Click **Enable Analytics**

### Step 4: Verify Analytics Integration

1. Go to **Analytics** in Firebase Console
2. You should see the Analytics dashboard
3. Wait 24-48 hours for initial data to appear

### Step 5: Configure Analytics Events

Firebase automatically tracks these authentication events:

- `login`: User signs in
- `sign_up`: New user creates account
- `logout`: User signs out

To track custom events:

```typescript
import { getAnalytics, logEvent } from 'firebase/analytics';

const analytics = getAnalytics();

// Log custom authentication event
logEvent(analytics, 'auth_method_selected', {
  method: 'google',
  timestamp: Date.now()
});
```

### Analytics Benefits

- **User Engagement**: Track active users and session duration
- **Authentication Methods**: See which sign-in methods are most popular
- **Conversion Funnels**: Track user journey from sign-up to conversion
- **Demographics**: Understand your user base
- **Debugging**: Identify authentication issues

### Important Notes

- **Privacy**: Ensure compliance with GDPR, CCPA, and other regulations
- **Data Retention**: Configure data retention settings
- **User Consent**: Implement consent management for EU users
- **Data Export**: Analytics data can be exported to BigQuery

## Downloading Service Account Credentials

Service account credentials are required for server-side Firebase operations, including Cloud Functions.

### Step 1: Navigate to Service Accounts

1. Go to **Project Settings** (gear icon)
2. Click on **Service Accounts** tab
3. You'll see your service account email

### Step 2: Generate Private Key

1. Click **Generate New Private Key** button
2. A warning dialog appears:
   ```
   This key is used to authenticate your application to Firebase services.
   Keep it confidential and never store it in a public repository.
   ```
3. Click **Generate Key**
4. A JSON file will be downloaded to your computer

### Step 3: Understand the JSON Structure

The downloaded file contains:

```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "abc123...",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com",
  "client_id": "123456789...",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/..."
}
```

### Step 4: Extract Required Values

For LumiBase, you need these three values:

1. **project_id**: Your Firebase project ID
2. **private_key**: The RSA private key (keep the `\n` characters!)
3. **client_email**: The service account email

### Step 5: Add to Environment Variables

Add to your `.env` file:

```bash
# Firebase Service Account
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n"
```

**Critical Notes:**

- Keep the quotes around `FIREBASE_PRIVATE_KEY`
- Keep the `\n` characters (they represent line breaks)
- Never commit this file to Git
- Add `.env` to `.gitignore`

### Step 6: Secure Storage Best Practices

**For Development:**
- Store in `.env` file (gitignored)
- Use environment variable managers (direnv, dotenv)

**For Production:**
- Use secret managers (AWS Secrets Manager, Google Secret Manager, Azure Key Vault)
- Use environment variables in hosting platform (Vercel, Netlify, Heroku)
- Rotate keys every 90 days
- Use different service accounts for dev/staging/prod

### Step 7: Verify Credentials

Test your credentials:

```typescript
import * as admin from 'firebase-admin';

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

// Test authentication
async function testCredentials() {
  try {
    const users = await admin.auth().listUsers(1);
    console.log('✅ Credentials valid!');
  } catch (error) {
    console.error('❌ Credentials invalid:', error);
  }
}
```

### Security Warnings

⚠️ **NEVER:**
- Commit service account JSON to Git
- Share credentials in Slack, email, or chat
- Store credentials in client-side code
- Use production credentials in development

⚠️ **ALWAYS:**
- Store credentials in environment variables
- Use secret managers in production
- Rotate keys regularly
- Monitor service account usage
- Revoke compromised keys immediately

## Configuring Firebase for Cloud Functions

Cloud Functions need access to Supabase to sync user data.

### Step 1: Install Firebase CLI

```bash
# Install globally
npm install -g firebase-tools

# Verify installation
firebase --version
```

### Step 2: Login to Firebase

```bash
# Login with your Google account
firebase login

# If already logged in, verify
firebase projects:list
```

### Step 3: Select Your Project

```bash
# Use your project
firebase use <your-project-id>

# Verify current project
firebase use
```

### Step 4: Set Supabase Configuration

Firebase Functions use runtime configuration to store secrets:

```bash
# Set Supabase URL
firebase functions:config:set supabase.url="https://xxxxxxxxxxxxx.supabase.co"

# Set Supabase Service Role Key
firebase functions:config:set supabase.service_key="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Step 5: Verify Configuration

```bash
# View all configuration
firebase functions:config:get

# Expected output:
# {
#   "supabase": {
#     "url": "https://xxxxxxxxxxxxx.supabase.co",
#     "service_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
#   }
# }
```

### Step 6: Configure for Local Development

For local testing with Firebase Emulator:

1. Create `functions/.runtimeconfig.json`:

```json
{
  "supabase": {
    "url": "https://xxxxxxxxxxxxx.supabase.co",
    "service_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

2. Add to `functions/.gitignore`:

```
.runtimeconfig.json
```

### Step 7: Access Configuration in Functions

In your Cloud Functions code:

```typescript
import * as functions from 'firebase-functions';

// Access configuration
const supabaseUrl = functions.config().supabase.url;
const supabaseServiceKey = functions.config().supabase.service_key;

// Use in Supabase client
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(supabaseUrl, supabaseServiceKey);
```

### Step 8: Deploy Functions

```bash
cd functions

# Install dependencies
npm install

# Build TypeScript
npm run build

# Deploy to Firebase
npm run deploy

# Or deploy specific function
firebase deploy --only functions:syncUserToSupabase
```

### Step 9: Verify Deployment

```bash
# List deployed functions
firebase functions:list

# View function logs
firebase functions:log

# View specific function logs
firebase functions:log --only syncUserToSupabase
```

### Configuration Management

**Environment-Specific Configuration:**

```bash
# Development
firebase use dev-project
firebase functions:config:set supabase.url="https://dev.supabase.co"

# Production
firebase use prod-project
firebase functions:config:set supabase.url="https://prod.supabase.co"
```

**Updating Configuration:**

```bash
# Update a value
firebase functions:config:set supabase.url="https://new-url.supabase.co"

# Remove a value
firebase functions:config:unset supabase.url

# Remove entire namespace
firebase functions:config:unset supabase
```

**Important Notes:**

- Configuration changes require redeployment
- Use different projects for dev/staging/prod
- Never commit `.runtimeconfig.json` to Git
- Monitor function logs for configuration errors

## Testing Authentication

### Test Google OAuth

1. **Create a test HTML file:**

```html
<!DOCTYPE html>
<html>
<head>
  <title>Firebase Auth Test</title>
</head>
<body>
  <h1>Firebase Authentication Test</h1>
  <button id="google-signin">Sign in with Google</button>
  <button id="signout">Sign out</button>
  <div id="user-info"></div>

  <script type="module">
    import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
    import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

    const firebaseConfig = {
      apiKey: "YOUR_WEB_API_KEY",
      authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
      projectId: "YOUR_PROJECT_ID",
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();

    document.getElementById('google-signin').addEventListener('click', async () => {
      try {
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        const token = await user.getIdToken();
        
        document.getElementById('user-info').innerHTML = `
          <h2>Signed in as:</h2>
          <p>Name: ${user.displayName}</p>
          <p>Email: ${user.email}</p>
          <p>UID: ${user.uid}</p>
          <p>Token: ${token.substring(0, 50)}...</p>
        `;
      } catch (error) {
        console.error('Error:', error);
        alert('Sign-in failed: ' + error.message);
      }
    });

    document.getElementById('signout').addEventListener('click', async () => {
      await signOut(auth);
      document.getElementById('user-info').innerHTML = '<p>Signed out</p>';
    });
  </script>
</body>
</html>
```

2. **Open in browser** and test sign-in

### Test Email/Password

```typescript
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';

const auth = getAuth();

// Test sign up
async function testSignUp() {
  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      'test@example.com',
      'SecurePassword123!'
    );
    console.log('✅ Sign up successful:', userCredential.user.uid);
  } catch (error) {
    console.error('❌ Sign up failed:', error.message);
  }
}

// Test sign in
async function testSignIn() {
  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      'test@example.com',
      'SecurePassword123!'
    );
    console.log('✅ Sign in successful:', userCredential.user.uid);
  } catch (error) {
    console.error('❌ Sign in failed:', error.message);
  }
}
```

### Test Cloud Function Sync

1. **Create a test user in Firebase Console:**
   - Go to Authentication → Users
   - Click **Add user**
   - Enter email and password
   - Click **Add user**

2. **Check Supabase database:**

```bash
# Connect to PostgreSQL
docker-compose exec postgres psql -U directus -d directus

# Query users table
SELECT * FROM public.users;

# You should see the synced user
```

3. **Check Cloud Function logs:**

```bash
firebase functions:log --only syncUserToSupabase
```

## Troubleshooting

### Google OAuth Issues

**Problem**: "Unauthorized domain" error

**Solution**:
1. Go to Firebase Console → Authentication → Settings
2. Add your domain to **Authorized domains**
3. For local development, ensure `localhost` is listed

---

**Problem**: OAuth consent screen not configured

**Solution**:
1. Go to Firebase Console → Authentication → Sign-in method
2. Click on Google provider
3. Configure project support email and app name
4. Save changes

---

**Problem**: "popup_closed_by_user" error

**Solution**:
- User closed the popup before completing sign-in
- This is expected behavior, not an error
- Handle gracefully in your UI

### Email/Password Issues

**Problem**: "Email already in use" error

**Solution**:
- Email is already registered
- Use sign-in instead of sign-up
- Or implement password reset flow

---

**Problem**: "Weak password" error

**Solution**:
- Firebase requires minimum 6 characters
- Implement stronger client-side validation
- Show password requirements to users

---

**Problem**: Email verification not sent

**Solution**:
1. Check email template configuration
2. Verify sender email is valid
3. Check spam folder
4. Ensure email service is not blocked

### Service Account Issues

**Problem**: "Invalid credentials" error

**Solution**:
1. Verify `FIREBASE_PRIVATE_KEY` has correct format
2. Ensure `\n` characters are preserved
3. Check quotes around private key in `.env`
4. Verify project ID matches

---

**Problem**: "Permission denied" error

**Solution**:
1. Verify service account has correct roles
2. Check Firebase project permissions
3. Ensure service account is not disabled

### Cloud Functions Issues

**Problem**: Functions not deploying

**Solution**:
```bash
# Re-authenticate
firebase login --reauth

# Verify project
firebase use <project-id>

# Check billing (Functions require Blaze plan)
firebase projects:list
```

---

**Problem**: Configuration not found

**Solution**:
```bash
# Verify configuration
firebase functions:config:get

# Re-set configuration
firebase functions:config:set supabase.url="..."
firebase functions:config:set supabase.service_key="..."

# Redeploy
firebase deploy --only functions
```

---

**Problem**: Function timeout

**Solution**:
1. Increase timeout in `functions/src/index.ts`:
```typescript
export const syncUserToSupabase = functions
  .runWith({ timeoutSeconds: 60 })
  .auth.user().onCreate(async (user) => {
    // ...
  });
```

2. Optimize function code
3. Check network latency to Supabase

## Security Best Practices

### Authentication Security

1. **Enable Email Verification**
   - Require email verification for new accounts
   - Prevent unverified users from accessing sensitive data

2. **Implement Rate Limiting**
   - Firebase automatically rate-limits authentication
   - Add additional rate limiting in your app

3. **Use Strong Passwords**
   - Enforce minimum 8 characters
   - Require uppercase, lowercase, numbers, and symbols
   - Implement password strength meter

4. **Enable Multi-Factor Authentication (MFA)**
   - Available in Firebase Authentication
   - Highly recommended for production apps

5. **Monitor Authentication Events**
   - Use Firebase Analytics to track auth events
   - Set up alerts for suspicious activities
   - Monitor failed login attempts

### Service Account Security

1. **Rotate Keys Regularly**
   - Rotate service account keys every 90 days
   - Automate key rotation if possible

2. **Use Least Privilege**
   - Grant minimum required permissions
   - Use different service accounts for different environments

3. **Secure Storage**
   - Never commit credentials to Git
   - Use secret managers in production
   - Encrypt credentials at rest

4. **Monitor Usage**
   - Enable audit logging
   - Monitor service account activity
   - Set up alerts for unusual patterns

5. **Revoke Compromised Keys**
   - Immediately revoke if compromised
   - Generate new keys
   - Update all deployments

### Cloud Functions Security

1. **Validate Input**
   - Always validate user input
   - Sanitize data before database operations

2. **Use Environment Variables**
   - Never hardcode secrets
   - Use Firebase Functions config

3. **Implement Error Handling**
   - Don't expose sensitive information in errors
   - Log errors securely

4. **Set Appropriate Timeouts**
   - Prevent long-running functions
   - Set reasonable timeout limits

5. **Monitor Function Logs**
   - Regularly review function logs
   - Set up alerts for errors
   - Monitor execution times

### General Security

1. **Keep Dependencies Updated**
   ```bash
   npm audit
   npm update
   ```

2. **Enable CORS Properly**
   - Only allow trusted domains
   - Don't use wildcard (*) in production

3. **Implement HTTPS Only**
   - Force HTTPS in production
   - Use secure cookies

4. **Regular Security Audits**
   - Review authentication flows
   - Test for vulnerabilities
   - Update security policies

---

## Additional Resources

- [Firebase Authentication Documentation](https://firebase.google.com/docs/auth)
- [Firebase Security Rules](https://firebase.google.com/docs/rules)
- [Firebase Best Practices](https://firebase.google.com/docs/auth/admin/best-practices)
- [OAuth 2.0 Documentation](https://oauth.net/2/)
- [JWT.io - JWT Debugger](https://jwt.io/)

---

**Need Help?**

- [Firebase Support](https://firebase.google.com/support)
- [Stack Overflow - Firebase Tag](https://stackoverflow.com/questions/tagged/firebase)
- [Firebase Community Slack](https://firebase.community/)
- [GitHub Issues](https://github.com/khuepm/LumiBase/issues)
