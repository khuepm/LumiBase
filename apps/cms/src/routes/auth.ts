import { Hono } from 'hono';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { users, userSites } from '@lumibase/database';
import type { AppEnv } from '../env';

export const authRouter = new Hono<AppEnv>();

// Helper to hash password using PBKDF2 via Web Crypto API
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    256 // 32 bytes
  );

  const hashArray = new Uint8Array(hashBuffer);
  
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return `pbkdf2$100000$${saltHex}$${hashHex}`;
}

// Helper to verify password
async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
    return false;
  }
  
  const iterationsStr = parts[1];
  const saltHex = parts[2];
  const storedHashHex = parts[3];

  if (!iterationsStr || !saltHex || !storedHashHex) {
    return false;
  }

  const iterations = parseInt(iterationsStr, 10);
  const encoder = new TextEncoder();
  const saltMatches = saltHex.match(/.{1,2}/g);
  if (!saltMatches) {
    return false;
  }
  const salt = new Uint8Array(saltMatches.map(byte => parseInt(byte, 16)));
  
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    passwordKey,
    256
  );
  
  const hashArray = new Uint8Array(hashBuffer);
  const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex === storedHashHex;
}

// Helper to sign Custom JWT (HS256)
async function signCustomJwt(payload: any, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secretKey);
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Custom Register (for Frontend Users)
authRouter.post('/register', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const body = await c.req.json();
  const input = registerSchema.parse(body);

  // Check if user exists by email
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (existingUser) {
    return c.json(
      { errors: [{ code: 'EMAIL_ALREADY_EXISTS', message: 'Email is already registered.' }] },
      400
    );
  }

  const passwordHash = await hashPassword(input.password);

  // Insert user
  const [newUser] = await db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      status: 'active',
    })
    .returning();

  if (!newUser) {
    return c.json({ errors: [{ code: 'REGISTRATION_FAILED', message: 'Failed to create user.' }] }, 500);
  }

  // Bind new user to the current site (default 'member' role)
  await db
    .insert(userSites)
    .values({
      userId: newUser.id,
      siteId,
      roleId: 'member',
    })
    .onConflictDoNothing();

  return c.json({
    data: {
      id: newUser.id,
      email: newUser.email,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
    },
  });
});

// Custom Login (for Frontend Users)
authRouter.post('/login', async (c) => {
  const db = c.get('db');
  const jwtSecret = c.env.JWT_SECRET;
  if (!jwtSecret) {
    return c.json(
      { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
      500
    );
  }

  const body = await c.req.json();
  const input = loginSchema.parse(body);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (!user || !user.passwordHash) {
    return c.json(
      { errors: [{ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }] },
      401
    );
  }

  const isValid = await verifyPassword(input.password, user.passwordHash);
  if (!isValid) {
    return c.json(
      { errors: [{ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }] },
      401
    );
  }

  // Generate JWT token
  const token = await signCustomJwt(
    {
      userId: user.id,
      email: user.email,
      roles: ['member'],
    },
    jwtSecret
  );

  return c.json({
    data: {
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
      },
    },
  });
});

// Profile Endpoint
authRouter.get('/me', async (c) => {
  const auth = c.get('auth');
  const siteId = c.get('siteId');

  return c.json({
    data: {
      logtoId: auth.externalId ?? auth.userId ?? 'anon', // Alias for backward compatibility
      userId: auth.userId,
      externalId: auth.externalId,
      email: auth.email,
      roles: auth.roles ?? [],
      isFrontendUser: auth.isFrontendUser ?? false,
      siteId,
      permissions: null,
    },
  });
});
