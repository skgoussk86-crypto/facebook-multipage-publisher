import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma-client';
import { createAdminSession, destroyAdminSession } from '@/lib/auth';
import bcrypt from 'bcryptjs';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

// Memory stores for login rate limiting (by IP and Email)
const ipLimits = new Map<string, RateLimitRecord>();
const emailLimits = new Map<string, RateLimitRecord>();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_ATTEMPTS = 5; // 5 attempts max per minute

function isRateLimited(key: string, limitMap: Map<string, RateLimitRecord>): boolean {
  const now = Date.now();
  const record = limitMap.get(key);

  if (!record) {
    limitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
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

// Valid bcrypt hash of "dummy" to utilize in dummy comparisons
const DUMMY_HASH = '$2a$10$N9qo8uLOqpJ5699475c75uxfR8Vd9L.F78v0Xl15d.L2O5074/3py';

export async function POST(request: NextRequest) {
  try {
    // 1. Rate limiting checks
    const ip = request.headers.get('cf-connecting-ip') || 
               request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
               request.headers.get('x-real-ip') || 
               '127.0.0.1';

    const body = await request.json();
    const { email, password } = body || {};

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (isRateLimited(ip, ipLimits) || isRateLimited(normalizedEmail, emailLimits)) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again in 1 minute.' }, 
        { status: 429 }
      );
    }

    // 2. Setup Check
    const adminCount = await prisma.user.count();
    if (adminCount === 0) {
      return NextResponse.json(
        { setupRequired: true, error: 'Setup required. No administrator account found. Run the bootstrap script to create one.' }, 
        { status: 400 }
      );
    }

    // 3. User verification
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    let isValid = false;
    if (user) {
      isValid = await bcrypt.compare(password, user.passwordHash);
    } else {
      // Execute bcrypt compare anyway to prevent timing attacks
      await bcrypt.compare(password, DUMMY_HASH);
    }

    if (!isValid || !user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // 4. Session cookie setup (secure if HTTPS)
    const isHttps = request.url.startsWith('https:') || request.headers.get('x-forwarded-proto') === 'https';
    await createAdminSession(user.id, user.email, isHttps, user.passwordHash);

    // Reset rate limits on successful login
    ipLimits.delete(ip);
    emailLimits.delete(normalizedEmail);

    return NextResponse.json({ success: true, email: user.email });
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await destroyAdminSession();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
