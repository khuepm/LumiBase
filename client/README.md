# Client-Side Integration Example

This directory contains example client-side code for integrating Firebase Authentication with Supabase database access.

## Overview

The `auth.ts` module provides a complete authentication solution that:

1. **Authenticates users** via Firebase Authentication (Google OAuth)
2. **Manages JWT tokens** from Firebase
3. **Integrates with Supabase** for database access
4. **Handles errors** comprehensively
5. **Provides type safety** with TypeScript

## Features

### Authentication Functions

- `signInWithGoogle()` - Sign in with Google OAuth popup
- `signOut()` - Sign out the current user
- `getCurrentUser()` - Get the currently authenticated user
- `getIdToken()` - Get the Firebase ID token (JWT)

### Data Access Functions

- `getUserData(firebaseUid)` - Fetch user data from Supabase database

### Session Management

- `refreshSupabaseSession()` - Refresh the Supabase session with a new Firebase token

### Initialization Functions

- `initializeFirebase(config?)` - Initialize Firebase app
- `initializeSupabase()` - Initialize Supabase client

## Installation

```bash
cd client
npm install
```

## Environment Variables

Create a `.env` file in the project root with the following variables:

```bash
# Firebase Configuration
FIREBASE_WEB_API_KEY=your_firebase_web_api_key
FIREBASE_PROJECT_ID=your_firebase_project_id

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Usage Examples

### Basic Authentication Flow

```typescript
import { 
  signInWithGoogle, 
  getUserData, 
  getCurrentUser 
} from './auth';

// Sign in with Google
try {
  const user = await signInWithGoogle();
  console.log('Signed in:', user.email);
  
  // Fetch user data from Supabase
  const userData = await getUserData(user.uid);
  console.log('User data:', userData);
} catch (error) {
  console.error('Authentication failed:', error.message);
}
```

### Check Current User

```typescript
import { getCurrentUser } from './auth';

const user = getCurrentUser();
if (user) {
  console.log('User is signed in:', user.email);
} else {
  console.log('No user signed in');
}
```

### Sign Out

```typescript
import { signOut } from './auth';

try {
  await signOut();
  console.log('Signed out successfully');
} catch (error) {
  console.error('Sign out failed:', error.message);
}
```

### Refresh Session

```typescript
import { refreshSupabaseSession } from './auth';

// Refresh the Supabase session periodically
setInterval(async () => {
  try {
    await refreshSupabaseSession();
    console.log('Session refreshed');
  } catch (error) {
    console.error('Session refresh failed:', error.message);
  }
}, 30 * 60 * 1000); // Every 30 minutes
```

### Custom Firebase Configuration

```typescript
import { initializeFirebase } from './auth';

// Initialize with custom config
initializeFirebase({
  apiKey: 'your-api-key',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project-id'
});
```

## Error Handling

The module provides two custom error types:

### AuthenticationError

Thrown when authentication operations fail:

```typescript
import { signInWithGoogle, AuthenticationError } from './auth';

try {
  await signInWithGoogle();
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Auth error:', error.message);
    console.error('Error code:', error.code);
    
    // Handle specific error codes
    switch (error.code) {
      case 'POPUP_CLOSED':
        console.log('User closed the popup');
        break;
      case 'POPUP_BLOCKED':
        console.log('Popup was blocked by browser');
        break;
      case 'NETWORK_ERROR':
        console.log('Network connection issue');
        break;
    }
  }
}
```

### DataFetchError

Thrown when data fetching operations fail:

```typescript
import { getUserData, DataFetchError } from './auth';

try {
  const data = await getUserData('user-id');
} catch (error) {
  if (error instanceof DataFetchError) {
    console.error('Data fetch error:', error.message);
    console.error('Error code:', error.code);
    
    // Handle specific error codes
    switch (error.code) {
      case 'USER_NOT_FOUND':
        console.log('User does not exist in database');
        break;
      case 'PERMISSION_DENIED':
        console.log('User not authorized to access this data');
        break;
    }
  }
}
```

## Error Codes

### Authentication Error Codes

- `INVALID_CONFIG` - Firebase or Supabase configuration is incomplete
- `INIT_FAILED` - Failed to initialize Firebase or Supabase
- `NOT_INITIALIZED` - Firebase Auth not initialized
- `POPUP_CLOSED` - Sign-in popup was closed by user
- `POPUP_BLOCKED` - Sign-in popup was blocked by browser
- `POPUP_ALREADY_OPEN` - Another sign-in popup is already open
- `NETWORK_ERROR` - Network error during sign-in
- `SIGNIN_FAILED` - Generic sign-in failure
- `NOT_AUTHENTICATED` - No user is currently signed in
- `TOKEN_FAILED` - Failed to get ID token
- `REFRESH_FAILED` - Failed to refresh Supabase session
- `SIGNOUT_FAILED` - Sign-out operation failed

### Data Fetch Error Codes

- `INVALID_UID` - Invalid Firebase UID provided
- `NOT_INITIALIZED` - Supabase client not initialized
- `USER_NOT_FOUND` - User not found in database
- `PERMISSION_DENIED` - Permission denied (RLS policy)
- `FETCH_FAILED` - Generic fetch failure
- `NO_DATA` - No data returned from database
- `UNEXPECTED_ERROR` - Unexpected error occurred

## Architecture

### Authentication Flow

```
1. User clicks "Sign in with Google"
   ↓
2. signInWithGoogle() opens popup
   ↓
3. User authenticates with Google
   ↓
4. Firebase creates/signs in user
   ↓
5. Firebase issues JWT token
   ↓
6. Token is set for Supabase client
   ↓
7. User can now access Supabase data
```

### Data Access Flow

```
1. Client calls getUserData(firebaseUid)
   ↓
2. Supabase client sends request with JWT token
   ↓
3. Supabase verifies JWT with Firebase
   ↓
4. RLS policies check permissions
   ↓
5. Data is returned if authorized
```

## Security Considerations

### JWT Token Management

- Tokens are automatically managed by Firebase
- Tokens expire after 1 hour
- Use `refreshSupabaseSession()` to get fresh tokens
- Never expose tokens in logs or client-side storage

### Row Level Security (RLS)

- Supabase RLS policies ensure users can only access their own data
- The `firebase_uid` in the JWT is used to filter data
- Service role key bypasses RLS (never use in client code)

### Environment Variables

- Never commit `.env` files to version control
- Use environment-specific configurations
- Rotate keys regularly in production

## Testing

Run tests with:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

## TypeScript

Build TypeScript:

```bash
npm run build
```

The compiled JavaScript will be in the `dist/` directory.

## Integration with React

```typescript
import { useEffect, useState } from 'react';
import { signInWithGoogle, getCurrentUser, getUserData } from './auth';

function App() {
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);

  useEffect(() => {
    const currentUser = getCurrentUser();
    if (currentUser) {
      setUser(currentUser);
      getUserData(currentUser.uid).then(setUserData);
    }
  }, []);

  const handleSignIn = async () => {
    try {
      const user = await signInWithGoogle();
      setUser(user);
      const data = await getUserData(user.uid);
      setUserData(data);
    } catch (error) {
      console.error('Sign in failed:', error);
    }
  };

  return (
    <div>
      {user ? (
        <div>
          <h1>Welcome, {user.email}</h1>
          {userData && (
            <div>
              <p>Display Name: {userData.display_name}</p>
              <p>Created: {userData.created_at}</p>
            </div>
          )}
        </div>
      ) : (
        <button onClick={handleSignIn}>Sign in with Google</button>
      )}
    </div>
  );
}
```

## Integration with Vue

```vue
<template>
  <div>
    <div v-if="user">
      <h1>Welcome, {{ user.email }}</h1>
      <div v-if="userData">
        <p>Display Name: {{ userData.display_name }}</p>
        <p>Created: {{ userData.created_at }}</p>
      </div>
    </div>
    <button v-else @click="handleSignIn">Sign in with Google</button>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { signInWithGoogle, getCurrentUser, getUserData } from './auth';

const user = ref(null);
const userData = ref(null);

onMounted(() => {
  const currentUser = getCurrentUser();
  if (currentUser) {
    user.value = currentUser;
    getUserData(currentUser.uid).then(data => {
      userData.value = data;
    });
  }
});

const handleSignIn = async () => {
  try {
    user.value = await signInWithGoogle();
    userData.value = await getUserData(user.value.uid);
  } catch (error) {
    console.error('Sign in failed:', error);
  }
};
</script>
```

## Troubleshooting

### "Firebase configuration is incomplete"

Make sure you have set the following environment variables:
- `FIREBASE_WEB_API_KEY`
- `FIREBASE_PROJECT_ID`

### "Supabase configuration is incomplete"

Make sure you have set the following environment variables:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### "Sign-in popup was blocked"

Enable popups for your domain in the browser settings.

### "User not found in database"

The user may not have been synced to Supabase yet. Wait a few seconds after sign-in and try again. Ensure the Firebase Cloud Function is deployed and working.

### "Permission denied"

Make sure:
1. You are signed in with a valid JWT token
2. The JWT token contains the `firebase_uid` claim
3. RLS policies are correctly configured in Supabase

## Related Documentation

- [Firebase Authentication Documentation](https://firebase.google.com/docs/auth)
- [Supabase JavaScript Client Documentation](https://supabase.com/docs/reference/javascript)
- [Firebase Setup Guide](../docs/firebase-authentication-guide.md)
- [Supabase Setup Guide](../docs/supabase-project-setup-guide.md)

## License

MIT
