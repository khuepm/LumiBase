/**
 * Client-side Authentication Integration
 * 
 * This module provides authentication functionality using Firebase Auth
 * and integrates with Supabase for data access.
 * 
 * Features:
 * - Google OAuth sign-in via Firebase
 * - JWT token management
 * - Supabase client integration with Firebase tokens
 * - User data retrieval from Supabase
 * - Comprehensive error handling
 */

import { initializeApp, FirebaseApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  Auth,
  UserCredential,
  User
} from 'firebase/auth';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Firebase configuration interface
interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

// User data interface matching Supabase schema
interface UserData {
  firebase_uid: string;
  email: string;
  display_name: string | null;
  photo_url: string | null;
  created_at: string;
  updated_at: string;
}

// Error types for better error handling
export class AuthenticationError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class DataFetchError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'DataFetchError';
  }
}

// Singleton instances
let firebaseApp: FirebaseApp | null = null;
let auth: Auth | null = null;
let supabase: SupabaseClient | null = null;

/**
 * Initialize Firebase app with configuration
 * 
 * @param config - Firebase configuration object
 * @throws {AuthenticationError} If configuration is invalid
 */
export function initializeFirebase(config?: FirebaseConfig): FirebaseApp {
  if (firebaseApp) {
    return firebaseApp;
  }

  try {
    const firebaseConfig: FirebaseConfig = config || {
      apiKey: process.env.FIREBASE_WEB_API_KEY || '',
      authDomain: `${process.env.FIREBASE_PROJECT_ID || ''}.firebaseapp.com`,
      projectId: process.env.FIREBASE_PROJECT_ID || '',
    };

    // Validate configuration
    if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
      throw new AuthenticationError(
        'Firebase configuration is incomplete. Please check FIREBASE_WEB_API_KEY and FIREBASE_PROJECT_ID environment variables.',
        'INVALID_CONFIG'
      );
    }

    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    
    return firebaseApp;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw new AuthenticationError(
      `Failed to initialize Firebase: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'INIT_FAILED'
    );
  }
}

/**
 * Initialize Supabase client with configuration
 * 
 * @throws {AuthenticationError} If configuration is invalid
 */
export function initializeSupabase(): SupabaseClient {
  if (supabase) {
    return supabase;
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

    // Validate configuration
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new AuthenticationError(
        'Supabase configuration is incomplete. Please check SUPABASE_URL and SUPABASE_ANON_KEY environment variables.',
        'INVALID_CONFIG'
      );
    }

    supabase = createClient(supabaseUrl, supabaseAnonKey);
    
    return supabase;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw new AuthenticationError(
      `Failed to initialize Supabase: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'INIT_FAILED'
    );
  }
}

/**
 * Sign in with Google using Firebase Authentication
 * 
 * This function:
 * 1. Opens Google sign-in popup
 * 2. Authenticates user with Firebase
 * 3. Retrieves JWT token from Firebase
 * 4. Sets the token for Supabase client
 * 
 * @returns Promise resolving to the authenticated Firebase User
 * @throws {AuthenticationError} If sign-in fails
 */
export async function signInWithGoogle(): Promise<User> {
  try {
    // Ensure Firebase is initialized
    if (!auth) {
      initializeFirebase();
    }

    if (!auth) {
      throw new AuthenticationError('Firebase Auth not initialized', 'NOT_INITIALIZED');
    }

    // Create Google Auth provider
    const provider = new GoogleAuthProvider();
    
    // Add scopes for additional user information
    provider.addScope('profile');
    provider.addScope('email');

    // Sign in with popup
    const result: UserCredential = await signInWithPopup(auth, provider);
    
    // Get ID token from Firebase
    const token = await result.user.getIdToken();
    
    // Initialize Supabase if not already done
    if (!supabase) {
      initializeSupabase();
    }

    // Set token for Supabase client
    // Note: Supabase will use this token to verify requests
    if (supabase) {
      await supabase.auth.setSession({
        access_token: token,
        refresh_token: '', // Firebase handles refresh internally
      });
    }
    
    return result.user;
  } catch (error: any) {
    // Handle specific Firebase Auth errors
    if (error.code === 'auth/popup-closed-by-user') {
      throw new AuthenticationError(
        'Sign-in popup was closed before completing authentication',
        'POPUP_CLOSED'
      );
    }
    
    if (error.code === 'auth/popup-blocked') {
      throw new AuthenticationError(
        'Sign-in popup was blocked by the browser',
        'POPUP_BLOCKED'
      );
    }
    
    if (error.code === 'auth/cancelled-popup-request') {
      throw new AuthenticationError(
        'Another sign-in popup is already open',
        'POPUP_ALREADY_OPEN'
      );
    }

    if (error.code === 'auth/network-request-failed') {
      throw new AuthenticationError(
        'Network error occurred during sign-in',
        'NETWORK_ERROR'
      );
    }

    // Generic error
    throw new AuthenticationError(
      `Sign-in failed: ${error.message || 'Unknown error'}`,
      error.code || 'SIGNIN_FAILED'
    );
  }
}

/**
 * Fetch user data from Supabase database
 * 
 * This function queries the public.users table in Supabase
 * using the Firebase UID. Row Level Security (RLS) policies
 * ensure users can only access their own data.
 * 
 * @param firebaseUid - The Firebase user ID
 * @returns Promise resolving to the user data
 * @throws {DataFetchError} If data fetch fails
 */
export async function getUserData(firebaseUid: string): Promise<UserData> {
  try {
    // Validate input
    if (!firebaseUid || typeof firebaseUid !== 'string') {
      throw new DataFetchError(
        'Invalid Firebase UID provided',
        'INVALID_UID'
      );
    }

    // Ensure Supabase is initialized
    if (!supabase) {
      initializeSupabase();
    }

    if (!supabase) {
      throw new DataFetchError('Supabase client not initialized', 'NOT_INITIALIZED');
    }

    // Query user data from Supabase
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', firebaseUid)
      .single();
    
    // Handle errors
    if (error) {
      // Handle specific Supabase errors
      if (error.code === 'PGRST116') {
        throw new DataFetchError(
          'User not found in database',
          'USER_NOT_FOUND'
        );
      }

      if (error.code === '42501') {
        throw new DataFetchError(
          'Permission denied. Please ensure you are authenticated.',
          'PERMISSION_DENIED'
        );
      }

      throw new DataFetchError(
        `Failed to fetch user data: ${error.message}`,
        error.code || 'FETCH_FAILED'
      );
    }

    // Validate data
    if (!data) {
      throw new DataFetchError(
        'No user data returned from database',
        'NO_DATA'
      );
    }

    return data as UserData;
  } catch (error) {
    if (error instanceof DataFetchError) {
      throw error;
    }
    
    throw new DataFetchError(
      `Unexpected error fetching user data: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'UNEXPECTED_ERROR'
    );
  }
}

/**
 * Get the current authenticated user from Firebase
 * 
 * @returns The current Firebase user or null if not authenticated
 */
export function getCurrentUser(): User | null {
  if (!auth) {
    return null;
  }
  return auth.currentUser;
}

/**
 * Sign out the current user
 * 
 * @throws {AuthenticationError} If sign-out fails
 */
export async function signOut(): Promise<void> {
  try {
    if (!auth) {
      throw new AuthenticationError('Firebase Auth not initialized', 'NOT_INITIALIZED');
    }

    await auth.signOut();

    // Clear Supabase session
    if (supabase) {
      await supabase.auth.signOut();
    }
  } catch (error) {
    throw new AuthenticationError(
      `Sign-out failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SIGNOUT_FAILED'
    );
  }
}

/**
 * Get the current Firebase ID token
 * 
 * @param forceRefresh - Whether to force refresh the token
 * @returns Promise resolving to the ID token
 * @throws {AuthenticationError} If token retrieval fails
 */
export async function getIdToken(forceRefresh: boolean = false): Promise<string> {
  try {
    if (!auth || !auth.currentUser) {
      throw new AuthenticationError('No user is currently signed in', 'NOT_AUTHENTICATED');
    }

    const token = await auth.currentUser.getIdToken(forceRefresh);
    return token;
  } catch (error) {
    throw new AuthenticationError(
      `Failed to get ID token: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'TOKEN_FAILED'
    );
  }
}

/**
 * Refresh the Supabase session with a new Firebase token
 * 
 * This should be called periodically to keep the Supabase session fresh
 * 
 * @throws {AuthenticationError} If refresh fails
 */
export async function refreshSupabaseSession(): Promise<void> {
  try {
    // Get fresh token from Firebase
    const token = await getIdToken(true);

    // Update Supabase session
    if (!supabase) {
      initializeSupabase();
    }

    if (supabase) {
      await supabase.auth.setSession({
        access_token: token,
        refresh_token: '',
      });
    }
  } catch (error) {
    throw new AuthenticationError(
      `Failed to refresh Supabase session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'REFRESH_FAILED'
    );
  }
}

// Export instances for advanced usage
export { auth, supabase, firebaseApp };
