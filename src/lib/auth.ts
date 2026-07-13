import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { encryptToken, decryptToken } from './crypto';
import { prisma } from './prisma-client';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export interface SessionPayload {
  userId: string;
  email: string;
  expiresAt: number;
  passwordHash?: string;
}

/**
 * Creates an encrypted session token and stores it in a cookie.
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
      where: {
        id: userId
      }
    });

    finalPasswordHash = user?.passwordHash;
  }

  if (!finalPasswordHash) {
    throw new Error('Unable to create session without a valid password hash.');
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
    maxAge: 60 * 60 * 24
  });

  return encryptedToken;
}

/**
 * Clears the current session cookie.
 */
export async function destroyAdminSession() {
  const cookieStore = await cookies();

  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Verifies the session in Next.js server components and server actions.
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

    if (!payload?.userId || !payload.email || !payload.expiresAt) {
      return null;
    }

    if (payload.expiresAt < Date.now()) {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: {
        id: payload.userId
      }
    });

    // Only active and administrator-approved users may use the application.
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.approvalStatus !== 'APPROVED'
    ) {
      return null;
    }

    // Invalidate the session when login-sensitive account data changes.
    if (
      !payload.passwordHash ||
      user.passwordHash !== payload.passwordHash ||
      user.email !== payload.email
    ) {
      return null;
    }

    return user;
  } catch (error) {
    console.error('Session verification failed:', error);

    return null;
  }
}

/**
 * Verifies the session cookie and applies CSRF protection to API requests.
 */
export async function verifyAdminSession(request: NextRequest) {
  try {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
      const origin = request.headers.get('origin');
      const referer = request.headers.get('referer');
      const host =
        request.headers.get('x-forwarded-host') ||
        request.headers.get('host');

      if (!host) {
        console.warn('CSRF Blocked: Request host header is missing.');

        return null;
      }

      if (origin) {
        const originUrl = new URL(origin);

        if (originUrl.host !== host) {
          console.warn(
            `CSRF Blocked: Origin ${originUrl.host} does not match Host ${host}`
          );

          return null;
        }
      } else if (referer) {
        const refererUrl = new URL(referer);

        if (refererUrl.host !== host) {
          console.warn(
            `CSRF Blocked: Referer ${refererUrl.host} does not match Host ${host}`
          );

          return null;
        }
      } else {
        console.warn(
          'CSRF Blocked: Mutating request without origin or referer header'
        );

        return null;
      }
    }

    return await getSessionUser();
  } catch (error) {
    console.error('Session or CSRF verification failed:', error);

    return null;
  }
}

/**
 * Checks whether the authenticated user has the administrator role.
 */
export function verifyAdminRole(user: { role: string }): boolean {
  return user.role === 'ADMIN';
}