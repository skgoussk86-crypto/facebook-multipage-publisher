import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { encryptToken, decryptToken } from './crypto';
import { prisma } from './prisma-client';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SessionPayload {
  userId: string;
  email: string;
  expiresAt: number;
  passwordHash?: string;
}

/**
 * Creates an encrypted session token and sets it in the cookie.
 */
export async function createAdminSession(
  userId: string,
  email: string,
  isHttps: boolean,
  passwordHash?: string
) {
  let finalPasswordHash = passwordHash;
  if (!finalPasswordHash) {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    finalPasswordHash = user?.passwordHash;
  }

  const payload: SessionPayload = {
    userId,
    email,
    expiresAt: Date.now() + SESSION_DURATION_MS,
    passwordHash: finalPasswordHash
  };

  const serialized = JSON.stringify(payload);
  const encryptedToken = encryptToken(serialized);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, encryptedToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 // 24 hours in seconds
  });

  return encryptedToken;
}

/**
 * Clears the session cookie.
 */
export async function destroyAdminSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Verifies the admin session in Next.js Server contexts (Components/Server Actions).
 */
export async function getSessionUser() {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (!sessionCookie) {
      return null;
    }

    const decrypted = decryptToken(sessionCookie);
    const payload = JSON.parse(decrypted) as SessionPayload;

    if (!payload || !payload.userId || !payload.expiresAt) {
      return null;
    }

    if (payload.expiresAt < Date.now()) {
      return null;
    }

    // Retrieve user from DB to verify validity
    const user = await prisma.user.findUnique({
      where: { id: payload.userId }
    });

    if (!user) {
      return null;
    }

    // Invalidate session if passwordHash or email doesn't match the current DB values
    if (!payload.passwordHash || user.passwordHash !== payload.passwordHash || user.email !== payload.email) {
      return null;
    }

    return user;
  } catch (error) {
    console.error('Session verification failed:', error);
    return null;
  }
}

/**
 * Verifies the admin session cookie and protects against CSRF for API requests.
 * Returns the verified user object or null if invalid.
 */
export async function verifyAdminSession(request: NextRequest) {
  try {
    // 1. CSRF Protection for mutating actions
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
      const origin = request.headers.get('origin');
      const referer = request.headers.get('referer');
      const host = request.headers.get('x-forwarded-host') || request.headers.get('host');

      if (origin) {
        const originUrl = new URL(origin);
        if (originUrl.host !== host) {
          console.warn(`CSRF Blocked: Origin ${originUrl.host} does not match Host ${host}`);
          return null;
        }
      } else if (referer) {
        const refererUrl = new URL(referer);
        if (refererUrl.host !== host) {
          console.warn(`CSRF Blocked: Referer ${refererUrl.host} does not match Host ${host}`);
          return null;
        }
      } else {
        // Mutating request has neither origin nor referer header
        console.warn('CSRF Blocked: Mutating request without origin or referer header');
        return null;
      }
    }

    // 2. Session verification using standard utility
    return await getSessionUser();
  } catch (error) {
    console.error('Session or CSRF verification failed:', error);
    return null;
  }
}
