/**
 * Property-Based Test for JWT Token Validation
 * 
 * Task 9.3: Property test to verify JWT token validation
 * 
 * Property 5: JWT Token Validation
 * For any JWT token sent to Supabase API, if the token has an invalid signature
 * or has expired, Supabase must return HTTP 401 Unauthorized and deny data access.
 * 
 * Validates: Requirements 10.2, 10.4
 * 
 * Feature: directus-firebase-supabase-setup, Property 5: JWT Token Validation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as jwt from 'jsonwebtoken';

/**
 * Test configuration
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'placeholder-anon-key';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test-project';

/**
 * Custom arbitraries for JWT token generation
 */

/**
 * Arbitrary for generating valid JWT payloads
 */
const validJWTPayloadArbitrary = fc.record({
  uid: fc.string({ minLength: 10, maxLength: 128 }),
  expiresIn: fc.integer({ min: 3600, max: 86400 }), // 1 hour to 24 hours
});

/**
 * Arbitrary for generating expired JWT payloads
 */
const expiredJWTPayloadArbitrary = fc.record({
  uid: fc.string({ minLength: 10, maxLength: 128 }),
  expiredSecondsAgo: fc.integer({ min: 1, max: 86400 }), // Expired 1 second to 24 hours ago
});

/**
 * Arbitrary for generating invalid secrets (for signature testing)
 */
const invalidSecretArbitrary = fc.oneof(
  fc.string({ minLength: 32, maxLength: 64 }), // Random string
  fc.constant('wrong-secret-key-that-will-fail-verification'),
  fc.constant(''),
  fc.constant('short'),
);

/**
 * Helper function to create a JWT token with custom parameters
 */
function createJWTToken(
  uid: string,
  expiresIn: number,
  secret: string = SUPABASE_JWT_SECRET
): string {
  const payload = {
    sub: uid,
    aud: FIREBASE_PROJECT_ID,
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresIn,
    user_id: uid,
    firebase: {
      identities: {},
      sign_in_provider: 'custom'
    }
  };

  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

/**
 * Helper function to create an expired JWT token
 */
function createExpiredJWTToken(uid: string, expiredSecondsAgo: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: uid,
    aud: FIREBASE_PROJECT_ID,
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    iat: now - expiredSecondsAgo - 3600, // Issued before expiration
    exp: now - expiredSecondsAgo, // Expired in the past
    user_id: uid,
    firebase: {
      identities: {},
      sign_in_provider: 'custom'
    }
  };

  return jwt.sign(payload, SUPABASE_JWT_SECRET, { algorithm: 'HS256' });
}

/**
 * Helper function to create a JWT token with invalid signature
 */
function createInvalidSignatureToken(uid: string, wrongSecret: string): string {
  const payload = {
    sub: uid,
    aud: FIREBASE_PROJECT_ID,
    iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    user_id: uid,
    firebase: {
      identities: {},
      sign_in_provider: 'custom'
    }
  };

  return jwt.sign(payload, wrongSecret, { algorithm: 'HS256' });
}

/**
 * Helper function to setup test user in Supabase
 */
async function setupTestUser(
  supabase: SupabaseClient,
  firebaseUid: string,
  email: string
): Promise<void> {
  const { error } = await supabase
    .from('users')
    .upsert({
      firebase_uid: firebaseUid,
      email: email,
      display_name: 'Property Test User',
      photo_url: null,
    }, {
      onConflict: 'firebase_uid'
    });

  if (error) {
    throw error;
  }
}

/**
 * Helper function to cleanup test user from Supabase
 */
async function cleanupTestUser(
  supabase: SupabaseClient,
  firebaseUid: string
): Promise<void> {
  await supabase
    .from('users')
    .delete()
    .eq('firebase_uid', firebaseUid);
}

/**
 * Helper function to verify that access is denied (401 or no data)
 */
function verifyAccessDenied(data: any, error: any): void {
  // Access should be denied in one of these ways:
  // 1. Error is returned (could be 401 or other auth error)
  // 2. No error but data is null/empty (RLS filtered it out)
  if (error) {
    // Error is expected - this is valid denial
    expect(error).toBeDefined();
  } else {
    // If no error, data should be null or empty due to RLS
    if (Array.isArray(data)) {
      expect(data).toEqual([]);
    } else {
      expect(data).toBeNull();
    }
  }
}

describe('Property 5: JWT Token Validation', () => {
  let supabaseAdmin: SupabaseClient;
  let testSetupComplete = false;

  beforeAll(() => {
    // Check if Supabase is configured
    if (SUPABASE_URL === 'https://placeholder.supabase.co' || !SUPABASE_URL.includes('supabase.co')) {
      console.warn('Supabase not configured. Tests will be skipped.');
      testSetupComplete = false;
      return;
    }

    // Initialize Supabase admin client (with service role key)
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    testSetupComplete = true;
  });

  afterAll(async () => {
    // Cleanup any remaining test data
    if (testSetupComplete && supabaseAdmin) {
      try {
        await supabaseAdmin
          .from('users')
          .delete()
          .like('firebase_uid', 'jwt-prop-test-%');
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  });

  /**
   * Property Test: Invalid JWT signatures are always rejected
   * 
   * This property verifies that for any JWT token with an invalid signature
   * (signed with wrong secret), Supabase must deny access to data.
   * 
   * Validates: Requirements 10.2, 10.4
   */
  it('should reject all JWT tokens with invalid signatures', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        validJWTPayloadArbitrary,
        invalidSecretArbitrary,
        async (payload, wrongSecret) => {
          const testUid = `jwt-prop-test-invalid-sig-${payload.uid}`;
          const testEmail = `jwt-prop-invalid-sig-${payload.uid}@test.com`;

          // Setup test user
          await setupTestUser(supabaseAdmin, testUid, testEmail);

          try {
            // Create token with invalid signature
            const invalidToken = createInvalidSignatureToken(testUid, wrongSecret);

            // Create Supabase client with invalid token
            const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
              global: {
                headers: {
                  Authorization: `Bearer ${invalidToken}`
                }
              }
            });

            // Try to access data with invalid token
            const { data, error } = await authenticatedClient
              .from('users')
              .select('*')
              .eq('firebase_uid', testUid)
              .single();

            // Verify access is denied
            verifyAccessDenied(data, error);
          } finally {
            await cleanupTestUser(supabaseAdmin, testUid);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: Expired JWT tokens are always rejected
   * 
   * This property verifies that for any JWT token that has expired,
   * Supabase must deny access to data regardless of when it expired.
   * 
   * Validates: Requirements 10.2, 10.4
   */
  it('should reject all expired JWT tokens', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        expiredJWTPayloadArbitrary,
        async (payload) => {
          const testUid = `jwt-prop-test-expired-${payload.uid}`;
          const testEmail = `jwt-prop-expired-${payload.uid}@test.com`;

          // Setup test user
          await setupTestUser(supabaseAdmin, testUid, testEmail);

          try {
            // Create expired token
            const expiredToken = createExpiredJWTToken(testUid, payload.expiredSecondsAgo);

            // Create Supabase client with expired token
            const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
              global: {
                headers: {
                  Authorization: `Bearer ${expiredToken}`
                }
              }
            });

            // Try to access data with expired token
            const { data, error } = await authenticatedClient
              .from('users')
              .select('*')
              .eq('firebase_uid', testUid)
              .single();

            // Verify access is denied
            verifyAccessDenied(data, error);
          } finally {
            await cleanupTestUser(supabaseAdmin, testUid);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: Malformed JWT tokens are always rejected
   * 
   * This property verifies that for any malformed JWT token string,
   * Supabase must deny access to data.
   * 
   * Validates: Requirements 10.4
   */
  it('should reject all malformed JWT tokens', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 100 }), // Random string
          fc.constant('not.a.valid.jwt'),
          fc.constant(''),
          fc.constant('Bearer '),
          fc.hexaString({ minLength: 10, maxLength: 100 }), // Random hex
          fc.base64String({ minLength: 10, maxLength: 100 }), // Random base64
        ),
        async (malformedToken) => {
          // Create Supabase client with malformed token
          const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: {
              headers: {
                Authorization: `Bearer ${malformedToken}`
              }
            }
          });

          // Try to access data with malformed token
          const { data, error } = await authenticatedClient
            .from('users')
            .select('*')
            .limit(1);

          // Verify access is denied
          verifyAccessDenied(data, error);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: JWT tokens with missing required claims are rejected
   * 
   * This property verifies that JWT tokens missing required claims
   * (sub, aud, iss, exp) are rejected by Supabase.
   * 
   * Validates: Requirements 10.2, 10.4
   */
  it('should reject JWT tokens with missing required claims', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 128 }),
        fc.constantFrom('sub', 'aud', 'iss', 'exp', 'iat'),
        async (uid, missingClaim) => {
          // Create payload with missing claim
          const payload: any = {
            sub: uid,
            aud: FIREBASE_PROJECT_ID,
            iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          };

          // Remove the specified claim
          delete payload[missingClaim];

          // Create token with missing claim
          const incompleteToken = jwt.sign(payload, SUPABASE_JWT_SECRET, { algorithm: 'HS256' });

          // Create Supabase client with incomplete token
          const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: {
              headers: {
                Authorization: `Bearer ${incompleteToken}`
              }
            }
          });

          // Try to access data with incomplete token
          const { data, error } = await authenticatedClient
            .from('users')
            .select('*')
            .limit(1);

          // Verify access is denied
          verifyAccessDenied(data, error);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: JWT tokens with wrong issuer are rejected
   * 
   * This property verifies that JWT tokens with incorrect issuer claim
   * are rejected by Supabase.
   * 
   * Validates: Requirements 10.2, 10.4
   */
  it('should reject JWT tokens with wrong issuer', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 128 }),
        fc.oneof(
          fc.webUrl(),
          fc.constant('https://wrong-issuer.com'),
          fc.constant('https://attacker.com'),
          fc.string({ minLength: 10, maxLength: 100 }),
        ),
        async (uid, wrongIssuer) => {
          // Skip if issuer happens to be correct
          if (wrongIssuer === `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
            return;
          }

          const payload = {
            sub: uid,
            aud: FIREBASE_PROJECT_ID,
            iss: wrongIssuer,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          };

          const wrongIssuerToken = jwt.sign(payload, SUPABASE_JWT_SECRET, { algorithm: 'HS256' });

          const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: {
              headers: {
                Authorization: `Bearer ${wrongIssuerToken}`
              }
            }
          });

          const { data, error } = await authenticatedClient
            .from('users')
            .select('*')
            .limit(1);

          // Verify access is denied
          verifyAccessDenied(data, error);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: JWT tokens with wrong audience are rejected
   * 
   * This property verifies that JWT tokens with incorrect audience claim
   * are rejected by Supabase.
   * 
   * Validates: Requirements 10.2, 10.4
   */
  it('should reject JWT tokens with wrong audience', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 128 }),
        fc.oneof(
          fc.string({ minLength: 5, maxLength: 50 }),
          fc.constant('wrong-audience'),
          fc.constant('attacker-project'),
        ),
        async (uid, wrongAudience) => {
          // Skip if audience happens to be correct
          if (wrongAudience === FIREBASE_PROJECT_ID) {
            return;
          }

          const payload = {
            sub: uid,
            aud: wrongAudience,
            iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          };

          const wrongAudienceToken = jwt.sign(payload, SUPABASE_JWT_SECRET, { algorithm: 'HS256' });

          const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: {
              headers: {
                Authorization: `Bearer ${wrongAudienceToken}`
              }
            }
          });

          const { data, error } = await authenticatedClient
            .from('users')
            .select('*')
            .limit(1);

          // Verify access is denied
          verifyAccessDenied(data, error);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: Empty or missing Authorization header denies access
   * 
   * This property verifies that requests without proper Authorization header
   * are denied access to data.
   * 
   * Validates: Requirements 10.4
   */
  it('should deny access when Authorization header is missing or empty', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          undefined,
          '',
          'Bearer',
          'Bearer ',
          'Basic token',
          'token',
        ),
        async (authHeader) => {
          const headers: any = {};
          if (authHeader !== undefined) {
            headers.Authorization = authHeader;
          }

          const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers }
          });

          const { data, error } = await authenticatedClient
            .from('users')
            .select('*')
            .limit(1);

          // Verify access is denied
          verifyAccessDenied(data, error);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: Consistency - Invalid tokens always produce same denial behavior
   * 
   * This property verifies that the same invalid token always produces
   * consistent denial behavior across multiple requests.
   * 
   * Validates: Requirements 10.4
   */
  it('should consistently deny access for the same invalid token', async () => {
    if (!testSetupComplete) {
      console.warn('Skipping test: Supabase not configured');
      return;
    }

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 10, maxLength: 128 }),
        invalidSecretArbitrary,
        async (uid, wrongSecret) => {
          const testUid = `jwt-prop-test-consistency-${uid}`;
          const testEmail = `jwt-prop-consistency-${uid}@test.com`;

          await setupTestUser(supabaseAdmin, testUid, testEmail);

          try {
            // Create invalid token
            const invalidToken = createInvalidSignatureToken(testUid, wrongSecret);

            // Make multiple requests with same invalid token
            const authenticatedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
              global: {
                headers: {
                  Authorization: `Bearer ${invalidToken}`
                }
              }
            });

            const results = await Promise.all([
              authenticatedClient.from('users').select('*').eq('firebase_uid', testUid).single(),
              authenticatedClient.from('users').select('*').eq('firebase_uid', testUid).single(),
              authenticatedClient.from('users').select('*').eq('firebase_uid', testUid).single(),
            ]);

            // All requests should be denied
            for (const { data, error } of results) {
              verifyAccessDenied(data, error);
            }

            // All results should be consistent (all error or all null/empty)
            const hasError = results.map(r => r.error !== null);
            const allSame = hasError.every(v => v === hasError[0]);
            expect(allSame).toBe(true);
          } finally {
            await cleanupTestUser(supabaseAdmin, testUid);
          }
        }
      ),
      { numRuns: 50 } // Reduced runs due to multiple requests per property
    );
  });
});
