import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma-client';
import { createAdminSession, destroyAdminSession } from '@/lib/auth';
import bcrypt from 'bcryptjs';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

const ipLimits = new Map<string, RateLimitRecord>();
const emailLimits = new Map<string, RateLimitRecord>();

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function isRateLimited(
  key: string,
  limitMap: Map<string, RateLimitRecord>
): boolean {
  const now = Date.now();
  const record = limitMap.get(key);

  if (!record) {
    limitMap.set(key, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS
    });

    return false;
  }

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;

    return false;
  }

  record.count += 1;

  return record.count > MAX_ATTEMPTS;
}

// Valid bcrypt hash used for dummy password comparisons.
const DUMMY_HASH =
  '$2a$10$N9qo8uLOqpJ5699475c75uxfR8Vd9L.F78v0Xl15d.L2O5074/3py';

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '127.0.0.1';

    const body = await request.json();
    const { email, password } = body || {};

    if (!email || !password) {
      return NextResponse.json(
        {
          error: 'Email and password are required'
        },
        { status: 400 }
      );
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    if (
      isRateLimited(ip, ipLimits) ||
      isRateLimited(normalizedEmail, emailLimits)
    ) {
      return NextResponse.json(
        {
          error: 'Too many login attempts. Please try again in 1 minute.'
        },
        { status: 429 }
      );
    }

    // Ensure at least one usable administrator account exists.
    const approvedAdminCount = await prisma.user.count({
      where: {
        role: 'ADMIN',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED'
      }
    });

    if (approvedAdminCount === 0) {
      return NextResponse.json(
        {
          setupRequired: true,
          error:
            'Setup required. No active and approved administrator account was found.'
        },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: {
        email: normalizedEmail
      }
    });

    let isValidPassword = false;

    if (user) {
      isValidPassword = await bcrypt.compare(
        String(password),
        user.passwordHash
      );
    } else {
      // Prevent timing attacks for unknown email addresses.
      await bcrypt.compare(String(password), DUMMY_HASH);
    }

    if (!user || !isValidPassword) {
      return NextResponse.json(
        {
          error: 'Invalid credentials'
        },
        { status: 401 }
      );
    }

    if (user.status !== 'ACTIVE') {
      return NextResponse.json(
        {
          error:
            'This account has been suspended. Please contact the administrator.'
        },
        { status: 403 }
      );
    }

    if (user.approvalStatus === 'PENDING') {
      return NextResponse.json(
        {
          error:
            'Your account is waiting for administrator approval. Please try again after it has been approved.'
        },
        { status: 403 }
      );
    }

    if (user.approvalStatus === 'REJECTED') {
      return NextResponse.json(
        {
          error: user.rejectionReason
            ? `Your registration was rejected: ${user.rejectionReason}`
            : 'Your registration was rejected by the administrator.'
        },
        { status: 403 }
      );
    }

    const isHttps =
      request.url.startsWith('https:') ||
      request.headers.get('x-forwarded-proto') === 'https';

    await createAdminSession(
      user.id,
      user.email,
      isHttps,
      user.passwordHash
    );

    await prisma.user.update({
      where: {
        id: user.id
      },
      data: {
        lastLoginAt: new Date()
      }
    });

    ipLimits.delete(ip);
    emailLimits.delete(normalizedEmail);

    return NextResponse.json({
      success: true,
      email: user.email
    });
  } catch (error) {
    console.error('Login error:', error);

    return NextResponse.json(
      {
        error: 'Internal Server Error'
      },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await destroyAdminSession();

    return NextResponse.json({
      success: true
    });
  } catch (error) {
    console.error('Logout error:', error);

    return NextResponse.json(
      {
        error: 'Internal Server Error'
      },
      { status: 500 }
    );
  }
}