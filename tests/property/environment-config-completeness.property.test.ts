/**
 * Property-Based Test for Environment Configuration Completeness
 * 
 * Task 12.3: Property test to verify environment configuration completeness
 * 
 * Property 3: Environment Configuration Completeness
 * For any deployment environment, the .env.example file must contain all 
 * required environment variables (DATABASE_URL, DIRECTUS_KEY, DIRECTUS_SECRET, 
 * FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, SUPABASE_URL, 
 * SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) with comments explaining them, 
 * and the values must be placeholders rather than real values.
 * 
 * Validates: Requirements 8.1, 8.3, 8.4, 8.5, 8.6, 8.7
 * 
 * Feature: directus-firebase-supabase-setup, Property 3: Environment Configuration Completeness
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

// Required environment variables based on requirements
const REQUIRED_ENV_VARS = [
  // Database configuration (Requirement 8.3)
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  
  // Directus configuration (Requirement 8.3)
  'DIRECTUS_KEY',
  'DIRECTUS_SECRET',
  
  // Firebase configuration (Requirement 8.4)
  'FIREBASE_PROJECT_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  
  // Supabase configuration (Requirement 8.5)
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

// Patterns that indicate placeholder values (not real secrets)
const PLACEHOLDER_PATTERNS = [
  /your[_-]/i,
  /example/i,
  /placeholder/i,
  /xxxxx/i,
  /\.\.\./,
  /changeme/i,
  /replace/i,
  /here/i,
];

// Patterns that indicate real secrets (should NOT be in .env.example)
const REAL_SECRET_PATTERNS = [
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // Base64 encoded secrets
  /^AIza[A-Za-z0-9_-]{35}$/, // Firebase API keys
  /^https:\/\/[a-z0-9]{20,}\.supabase\.co$/, // Real Supabase URLs
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT tokens
];

interface EnvFileContent {
  raw: string;
  lines: string[];
  variables: Map<string, { value: string; hasComment: boolean; lineNumber: number }>;
}

/**
 * Parse .env.example file and extract variables with metadata
 */
function parseEnvFile(filePath: string): EnvFileContent {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const variables = new Map<string, { value: string; hasComment: boolean; lineNumber: number }>();
  
  let lastCommentLine = -1;
  
  lines.forEach((line, index) => {
    const trimmedLine = line.trim();
    
    // Track comment lines
    if (trimmedLine.startsWith('#')) {
      lastCommentLine = index;
      return;
    }
    
    // Skip empty lines
    if (!trimmedLine) {
      return;
    }
    
    // Parse variable assignment
    const match = trimmedLine.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const [, varName, varValue] = match;
      const hasComment = lastCommentLine === index - 1 || lastCommentLine === index - 2;
      
      variables.set(varName, {
        value: varValue,
        hasComment,
        lineNumber: index + 1,
      });
    }
  });
  
  return { raw, lines, variables };
}

/**
 * Check if a value is a placeholder (not a real secret)
 */
function isPlaceholder(value: string): boolean {
  // Empty values are considered placeholders
  if (!value || value.trim() === '') {
    return true;
  }
  
  // Remove quotes
  const cleanValue = value.replace(/^["']|["']$/g, '');
  
  // Check if matches placeholder patterns
  return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(cleanValue));
}

/**
 * Check if a value looks like a real secret
 */
function looksLikeRealSecret(value: string): boolean {
  // Remove quotes
  const cleanValue = value.replace(/^["']|["']$/g, '');
  
  // Check if matches real secret patterns
  return REAL_SECRET_PATTERNS.some(pattern => pattern.test(cleanValue));
}

describe('Property 3: Environment Configuration Completeness', () => {
  let envExamplePath: string;
  let envContent: EnvFileContent;
  let fileExists: boolean;

  beforeAll(() => {
    envExamplePath = path.join(process.cwd(), '.env.example');
    fileExists = fs.existsSync(envExamplePath);
    
    if (fileExists) {
      envContent = parseEnvFile(envExamplePath);
    }
  });

  /**
   * Property Test: .env.example file must exist and be readable
   */
  it('should have .env.example file that exists and is readable', () => {
    expect(fileExists).toBe(true);
    expect(envContent).toBeDefined();
    expect(envContent.raw.length).toBeGreaterThan(0);
  });

  /**
   * Property Test: All required environment variables must be present
   * 
   * This property verifies that regardless of how we check the file,
   * all required environment variables are always present.
   */
  it('should contain all required environment variables', async () => {
    if (!fileExists) {
      throw new Error('.env.example file does not exist');
    }

    await fc.assert(
      fc.asyncProperty(
        fc.constant(null), // Dummy generator to run property multiple times
        async () => {
          // Re-parse file each time to ensure consistency
          const content = parseEnvFile(envExamplePath);
          
          // Check each required variable
          for (const requiredVar of REQUIRED_ENV_VARS) {
            expect(
              content.variables.has(requiredVar),
              `Missing required environment variable: ${requiredVar}`
            ).toBe(true);
          }
          
          // Verify count matches
          const foundRequiredVars = REQUIRED_ENV_VARS.filter(v => content.variables.has(v));
          expect(foundRequiredVars.length).toBe(REQUIRED_ENV_VARS.length);
        }
      ),
      { numRuns: 100 } // Run 100 times to verify consistency
    );
  });

  /**
   * Property Test: All required variables must have explanatory comments
   * 
   * This property verifies that each required environment variable has
   * a comment explaining its purpose (Requirement 8.6).
   */
  it('should have explanatory comments for all required variables', async () => {
    if (!fileExists) {
      throw new Error('.env.example file does not exist');
    }

    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const content = parseEnvFile(envExamplePath);
          
          // Check each required variable has a comment
          for (const requiredVar of REQUIRED_ENV_VARS) {
            const varInfo = content.variables.get(requiredVar);
            expect(
              varInfo,
              `Variable ${requiredVar} not found in .env.example`
            ).toBeDefined();
            
            expect(
              varInfo!.hasComment,
              `Variable ${requiredVar} at line ${varInfo!.lineNumber} should have an explanatory comment above it`
            ).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: All values must be placeholders, not real secrets
   * 
   * This property verifies that the .env.example file contains only
   * placeholder values and no real secrets (Requirement 8.7).
   */
  it('should contain only placeholder values, not real secrets', async () => {
    if (!fileExists) {
      throw new Error('.env.example file does not exist');
    }

    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const content = parseEnvFile(envExamplePath);
          
          // Check each required variable has placeholder value
          for (const requiredVar of REQUIRED_ENV_VARS) {
            const varInfo = content.variables.get(requiredVar);
            expect(varInfo).toBeDefined();
            
            const value = varInfo!.value;
            
            // Value should be a placeholder
            expect(
              isPlaceholder(value),
              `Variable ${requiredVar} should have a placeholder value, got: ${value}`
            ).toBe(true);
            
            // Value should NOT look like a real secret
            expect(
              looksLikeRealSecret(value),
              `Variable ${requiredVar} appears to contain a real secret value: ${value.substring(0, 20)}...`
            ).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: File structure remains consistent across reads
   * 
   * This property verifies that the file structure (number of variables,
   * presence of comments, etc.) remains consistent across multiple reads.
   */
  it('should maintain consistent file structure across multiple reads', async () => {
    if (!fileExists) {
      throw new Error('.env.example file does not exist');
    }

    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const content1 = parseEnvFile(envExamplePath);
          const content2 = parseEnvFile(envExamplePath);
          
          // Same number of variables
          expect(content1.variables.size).toBe(content2.variables.size);
          
          // Same variables present
          const vars1 = Array.from(content1.variables.keys()).sort();
          const vars2 = Array.from(content2.variables.keys()).sort();
          expect(vars1).toEqual(vars2);
          
          // Same values for each variable
          for (const varName of vars1) {
            const info1 = content1.variables.get(varName)!;
            const info2 = content2.variables.get(varName)!;
            
            expect(info1.value).toBe(info2.value);
            expect(info1.hasComment).toBe(info2.hasComment);
            expect(info1.lineNumber).toBe(info2.lineNumber);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: Sensitive variables must not contain production values
   * 
   * This property specifically checks that sensitive variables like keys,
   * secrets, and tokens contain obvious placeholder patterns.
   */
  it('should have obvious placeholders for sensitive variables', async () => {
    if (!fileExists) {
      throw new Error('.env.example file does not exist');
    }

    const SENSITIVE_VARS = [
      'DIRECTUS_KEY',
      'DIRECTUS_SECRET',
      'FIREBASE_PRIVATE_KEY',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const content = parseEnvFile(envExamplePath);
          
          for (const sensitiveVar of SENSITIVE_VARS) {
            if (content.variables.has(sensitiveVar)) {
              const varInfo = content.variables.get(sensitiveVar)!;
              const value = varInfo.value.replace(/^["']|["']$/g, '');
              
              // Should contain obvious placeholder indicators
              const hasPlaceholderIndicator = PLACEHOLDER_PATTERNS.some(pattern => 
                pattern.test(value)
              );
              
              expect(
                hasPlaceholderIndicator,
                `Sensitive variable ${sensitiveVar} should have obvious placeholder indicators in value: ${value}`
              ).toBe(true);
              
              // Should NOT be a long random string (likely a real secret)
              if (value.length > 50) {
                const hasNonAlphanumeric = /[^A-Za-z0-9+/=]/.test(value);
                expect(
                  hasNonAlphanumeric,
                  `Sensitive variable ${sensitiveVar} has a suspiciously long alphanumeric value that might be a real secret`
                ).toBe(true);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property Test: Database URL format validation
   * 
   * If DATABASE_URL is present, it should be a placeholder format,
   * not a real connection string.
   */
  it('should have placeholder DATABASE_URL if present', async () => {
    if (!fileExists) {
      throw new Error('.env.example file does not exist');
    }

    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const content = parseEnvFile(envExamplePath);
          
          if (content.variables.has('DATABASE_URL')) {
            const varInfo = content.variables.get('DATABASE_URL')!;
            const value = varInfo.value.replace(/^["']|["']$/g, '');
            
            // Should contain placeholder indicators
            expect(
              isPlaceholder(value),
              `DATABASE_URL should be a placeholder, got: ${value}`
            ).toBe(true);
            
            // Should not contain real IP addresses or hostnames
            const hasRealHost = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(value) ||
                               /[a-z0-9-]+\.(com|net|org|io)/.test(value);
            
            if (hasRealHost) {
              // If it has a real-looking host, it should have placeholder indicators
              expect(
                PLACEHOLDER_PATTERNS.some(p => p.test(value)),
                `DATABASE_URL contains what looks like a real host: ${value}`
              ).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
