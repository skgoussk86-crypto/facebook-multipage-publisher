import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma-client';
import bcrypt from 'bcryptjs';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

// Memory store for registration rate limiting (by IP)
const ipLimits = new Map<string, RateLimitRecord>();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REGISTRATION_ATTEMPTS = 3; // Max 3 registrations per IP per minute

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const record = ipLimits.get(key);

  if (!record) {
    ipLimits.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
    return false;
  }

  record.count += 1;
  return record.count > MAX_REGISTRATION_ATTEMPTS;
}

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get('cf-connecting-ip') || 
               request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
               request.headers.get('x-real-ip') || 
               '127.0.0.1';

    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again in 1 minute.' }, 
        { status: 429 }
      );
    }

    const body = await request.json();
    const { email, password, name } = body || {};

    if (!email || !password || !name) {
      return NextResponse.json({ error: 'Name, email, and password are required' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail.includes('@')) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    if (password.length < 12) {
      return NextResponse.json({ error: 'Password must be at least 12 characters long' }, { status: 400 });
    }

    // Check if email already registered
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      return NextResponse.json({ error: 'Email address already registered' }, { status: 400 });
    }

    // Secure password hashing
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create new USER account
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: name.trim(),
        role: 'USER',
        status: 'ACTIVE'
      }
    });

    return NextResponse.json({ 
      success: true, 
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
