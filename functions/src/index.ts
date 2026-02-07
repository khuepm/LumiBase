import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

// Initialize Firebase Admin SDK
admin.initializeApp();

// Initialize Supabase client with service role key
// Note: These will be configured via Firebase Functions config
const supabaseUrl = functions.config().supabase?.url || process.env.SUPABASE_URL || '';
const supabaseServiceKey = functions.config().supabase?.service_key || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Create Supabase client (will be properly configured when deployed)
const supabase = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Cloud Function triggered when a new user is created in Firebase Auth
 * Syncs user data to Supabase database
 * 
 * Requirements:
 * - 6.1: Triggers on onCreate event
 * - 6.2: Extracts firebase_uid, email, displayName, photoURL
 * - 6.3: Inserts or updates record in public.users table
 * - 6.4: Uses Supabase service role key to bypass RLS
 * - 6.5: Handles duplicate email errors with retry logic
 * - 6.6: Completes within 5 seconds (configured via timeoutSeconds)
 * - 6.7: Full error handling and logging
 * 
 * @param user - The Firebase user object
 * @returns Promise with success status
 */
export const syncUserToSupabase = functions
  .runWith({
    timeoutSeconds: 5, // Requirement 6.6: Ensure function completes within 5 seconds
    memory: '256MB'
  })
  .auth.user().onCreate(async (user) => {
    const startTime = Date.now();
    const { uid, email, displayName, photoURL } = user;

    console.log(`[syncUserToSupabase] Starting sync for user: ${uid}`, {
      email,
      displayName,
      photoURL
    });

    // Requirement 6.2: Extract user data from Firebase user object
    const userData = {
      firebase_uid: uid,
      email: email || '',
      display_name: displayName || null,
      photo_url: photoURL || null,
      updated_at: new Date().toISOString(),
    };

    // Requirement 6.5: Retry logic for handling errors
    const maxRetries = 2;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[syncUserToSupabase] Attempt ${attempt}/${maxRetries} for user: ${uid}`);

        // Requirement 6.3 & 6.4: Insert or update using service role key (bypasses RLS)
        const { error } = await supabase
          .from('users')
          .upsert(userData, {
            onConflict: 'firebase_uid'
          });

        if (error) {
          // Log specific error details
          console.error(`[syncUserToSupabase] Supabase error on attempt ${attempt}:`, {
            code: error.code,
            message: error.message,
            details: error.details,
            hint: error.hint
          });

          // Requirement 6.5: Handle duplicate email specifically
          if (error.code === '23505' && error.message.includes('email')) {
            console.warn(`[syncUserToSupabase] Duplicate email detected for user ${uid}, retrying with upsert...`);
            lastError = error;
            
            // On duplicate email, try to update by firebase_uid
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, 100 * attempt)); // Exponential backoff
              continue;
            }
          }
          
          throw error;
        }

        // Success - log completion time
        const duration = Date.now() - startTime;
        console.log(`[syncUserToSupabase] Successfully synced user ${uid} in ${duration}ms`);
        
        // Requirement 6.6: Verify completion time
        if (duration > 5000) {
          console.warn(`[syncUserToSupabase] Function took ${duration}ms, exceeding 5 second target`);
        }

        return { success: true, uid, duration };

      } catch (error: any) {
        lastError = error;
        console.error(`[syncUserToSupabase] Attempt ${attempt} failed:`, {
          error: error.message,
          code: error.code,
          uid
        });

        // If not last attempt, wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        }
      }
    }

    // All retries failed
    const duration = Date.now() - startTime;
    console.error(`[syncUserToSupabase] Failed to sync user ${uid} after ${maxRetries} attempts in ${duration}ms`, {
      lastError: lastError?.message,
      code: lastError?.code
    });

    // Requirement 6.7: Don't throw - we don't want to block user creation in Firebase
    return { 
      success: false, 
      uid,
      error: lastError?.message || 'Unknown error',
      attempts: maxRetries,
      duration
    };
  });

/**
 * Optional: Cloud Function to handle user deletion
 * Removes user data from Supabase when deleted from Firebase Auth
 * 
 * @param user - The Firebase user object
 * @returns Promise with success status
 */
export const deleteUserFromSupabase = functions.auth.user().onDelete(async (user) => {
  const { uid } = user;

  console.log(`Deleting user from Supabase: ${uid}`);

  try {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('firebase_uid', uid);

    if (error) {
      console.error('Error deleting user from Supabase:', error);
      throw error;
    }

    console.log('Successfully deleted user from Supabase:', uid);
    return { success: true, uid };
  } catch (error: any) {
    console.error('Failed to delete user:', error);
    return { success: false, error: error.message };
  }
});
