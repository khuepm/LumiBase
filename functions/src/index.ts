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
 * @param user - The Firebase user object
 * @returns Promise with success status
 */
export const syncUserToSupabase = functions.auth.user().onCreate(async (user) => {
  const { uid, email, displayName, photoURL } = user;

  console.log(`Syncing user to Supabase: ${uid}`);

  try {
    // Insert or update user in Supabase
    const { error } = await supabase
      .from('users')
      .upsert({
        firebase_uid: uid,
        email: email || '',
        display_name: displayName || null,
        photo_url: photoURL || null,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'firebase_uid'
      });

    if (error) {
      console.error('Error syncing user to Supabase:', error);
      throw error;
    }

    console.log('Successfully synced user to Supabase:', uid);
    return { success: true, uid };
  } catch (error: any) {
    console.error('Failed to sync user:', error);
    // Don't throw - we don't want to block user creation
    return { success: false, error: error.message };
  }
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
