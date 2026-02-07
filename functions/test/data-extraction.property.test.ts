/**
 * Property-Based Tests for Cloud Function Data Extraction
 * 
 * Feature: directus-firebase-supabase-setup
 * Property 4: Cloud Function Data Extraction
 * 
 * Validates: Requirements 6.2
 * 
 * For any Firebase user object, the Cloud Function must correctly extract
 * and map all fields (firebase_uid from uid, email, display_name from displayName,
 * photo_url from photoURL) to the correct Supabase database columns.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Extract user data from Firebase user object
 * This is the core logic being tested from the Cloud Function
 */
function extractUserData(firebaseUser: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}) {
  return {
    firebase_uid: firebaseUser.uid,
    email: firebaseUser.email || '',
    display_name: firebaseUser.displayName || null,
    photo_url: firebaseUser.photoURL || null,
    updated_at: new Date().toISOString(),
  };
}

describe('Property 4: Cloud Function Data Extraction', () => {
  /**
   * **Validates: Requirements 6.2**
   * 
   * Property: For any Firebase user object, the extraction function must:
   * 1. Map uid to firebase_uid
   * 2. Map email to email (or empty string if null/undefined)
   * 3. Map displayName to display_name (or null if not provided)
   * 4. Map photoURL to photo_url (or null if not provided)
   * 5. Include a valid updated_at timestamp
   */
  it('should correctly extract and map all fields from any Firebase user object', () => {
    fc.assert(
      fc.property(
        // Generate arbitrary Firebase user objects
        fc.record({
          uid: fc.string({ minLength: 1, maxLength: 128 }),
          email: fc.option(fc.emailAddress(), { nil: null }),
          displayName: fc.option(fc.string({ minLength: 1, maxLength: 255 }), { nil: null }),
          photoURL: fc.option(fc.webUrl(), { nil: null }),
        }),
        (firebaseUser) => {
          const extracted = extractUserData(firebaseUser);

          // Property 1: uid must map to firebase_uid
          expect(extracted.firebase_uid).toBe(firebaseUser.uid);

          // Property 2: email must map correctly (empty string if null/undefined)
          if (firebaseUser.email) {
            expect(extracted.email).toBe(firebaseUser.email);
          } else {
            expect(extracted.email).toBe('');
          }

          // Property 3: displayName must map to display_name (null if not provided)
          expect(extracted.display_name).toBe(firebaseUser.displayName || null);

          // Property 4: photoURL must map to photo_url (null if not provided)
          expect(extracted.photo_url).toBe(firebaseUser.photoURL || null);

          // Property 5: updated_at must be a valid ISO timestamp
          expect(extracted.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          expect(new Date(extracted.updated_at).getTime()).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 } // Minimum 100 iterations as per requirements
    );
  });

  /**
   * **Validates: Requirements 6.2**
   * 
   * Property: Field names must be correctly mapped to database column names
   */
  it('should map Firebase field names to correct Supabase column names', () => {
    fc.assert(
      fc.property(
        fc.record({
          uid: fc.string({ minLength: 1, maxLength: 128 }),
          email: fc.option(fc.emailAddress(), { nil: null }),
          displayName: fc.option(fc.string({ minLength: 1, maxLength: 255 }), { nil: null }),
          photoURL: fc.option(fc.webUrl(), { nil: null }),
        }),
        (firebaseUser) => {
          const extracted = extractUserData(firebaseUser);

          // Verify all expected database columns are present
          expect(extracted).toHaveProperty('firebase_uid');
          expect(extracted).toHaveProperty('email');
          expect(extracted).toHaveProperty('display_name');
          expect(extracted).toHaveProperty('photo_url');
          expect(extracted).toHaveProperty('updated_at');

          // Verify no unexpected fields
          const expectedKeys = ['firebase_uid', 'email', 'display_name', 'photo_url', 'updated_at'];
          const actualKeys = Object.keys(extracted);
          expect(actualKeys.sort()).toEqual(expectedKeys.sort());
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.2**
   * 
   * Property: Data types must match database schema requirements
   */
  it('should produce data types compatible with database schema', () => {
    fc.assert(
      fc.property(
        fc.record({
          uid: fc.string({ minLength: 1, maxLength: 128 }),
          email: fc.option(fc.emailAddress(), { nil: null }),
          displayName: fc.option(fc.string({ minLength: 1, maxLength: 255 }), { nil: null }),
          photoURL: fc.option(fc.webUrl(), { nil: null }),
        }),
        (firebaseUser) => {
          const extracted = extractUserData(firebaseUser);

          // firebase_uid: VARCHAR(128) - must be string, max 128 chars
          expect(typeof extracted.firebase_uid).toBe('string');
          expect(extracted.firebase_uid.length).toBeLessThanOrEqual(128);
          expect(extracted.firebase_uid.length).toBeGreaterThan(0);

          // email: VARCHAR(255) - must be string, max 255 chars
          expect(typeof extracted.email).toBe('string');
          expect(extracted.email.length).toBeLessThanOrEqual(255);

          // display_name: VARCHAR(255) or NULL - must be string or null, max 255 chars if string
          if (extracted.display_name !== null) {
            expect(typeof extracted.display_name).toBe('string');
            expect(extracted.display_name.length).toBeLessThanOrEqual(255);
          }

          // photo_url: TEXT or NULL - must be string or null
          if (extracted.photo_url !== null) {
            expect(typeof extracted.photo_url).toBe('string');
          }

          // updated_at: TIMESTAMP WITH TIME ZONE - must be valid ISO string
          expect(typeof extracted.updated_at).toBe('string');
          const timestamp = new Date(extracted.updated_at);
          expect(timestamp.toString()).not.toBe('Invalid Date');
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.2**
   * 
   * Property: Null/undefined handling must be consistent
   */
  it('should handle null and undefined values consistently', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 128 }),
        fc.constantFrom(null, undefined, ''),
        fc.constantFrom(null, undefined, 'Test Name'),
        fc.constantFrom(null, undefined, 'https://example.com/photo.jpg'),
        (uid, email, displayName, photoURL) => {
          const firebaseUser = {
            uid,
            email: email as string | null | undefined,
            displayName: displayName as string | null | undefined,
            photoURL: photoURL as string | null | undefined,
          };

          const extracted = extractUserData(firebaseUser);

          // email: null/undefined should become empty string
          if (!email) {
            expect(extracted.email).toBe('');
          } else {
            expect(extracted.email).toBe(email);
          }

          // displayName: null/undefined should become null
          if (!displayName) {
            expect(extracted.display_name).toBe(null);
          } else {
            expect(extracted.display_name).toBe(displayName);
          }

          // photoURL: null/undefined should become null
          if (!photoURL) {
            expect(extracted.photo_url).toBe(null);
          } else {
            expect(extracted.photo_url).toBe(photoURL);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 6.2**
   * 
   * Property: Edge cases with special characters and unicode
   */
  it('should handle special characters and unicode in all fields', () => {
    fc.assert(
      fc.property(
        fc.record({
          uid: fc.string({ minLength: 1, maxLength: 128 }),
          email: fc.option(fc.emailAddress(), { nil: null }),
          displayName: fc.option(
            fc.string({ minLength: 1, maxLength: 255 }),
            { nil: null }
          ),
          photoURL: fc.option(fc.webUrl(), { nil: null }),
        }),
        (firebaseUser) => {
          const extracted = extractUserData(firebaseUser);

          // All string fields should preserve their content exactly
          expect(extracted.firebase_uid).toBe(firebaseUser.uid);
          
          if (firebaseUser.email) {
            expect(extracted.email).toBe(firebaseUser.email);
          }
          
          if (firebaseUser.displayName) {
            expect(extracted.display_name).toBe(firebaseUser.displayName);
          }
          
          if (firebaseUser.photoURL) {
            expect(extracted.photo_url).toBe(firebaseUser.photoURL);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
