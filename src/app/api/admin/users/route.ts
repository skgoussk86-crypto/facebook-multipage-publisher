import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma-client';
import { verifyAdminSession, verifyAdminRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!verifyAdminRole(user)) {
      return NextResponse.json({ error: 'Forbidden: Admin role required' }, { status: 403 });
    }

    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' }
    });

    // Sanitize user details
    const sanitizedUsers = users.map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt
    }));

    return NextResponse.json({ success: true, users: sanitizedUsers });
  } catch (error) {
    console.error('Error listing users:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!verifyAdminRole(user)) {
      return NextResponse.json({ error: 'Forbidden: Admin role required' }, { status: 403 });
    }

    const body = await request.json();
    const { targetUserId, role, status } = body || {};

    if (!targetUserId) {
      return NextResponse.json({ error: 'Target User ID is required' }, { status: 400 });
    }

    // Safety check: prevent modifying own role or status
    if (targetUserId === user.id) {
      return NextResponse.json(
        { error: 'Self-modification safety trigger: You cannot change your own role or suspend yourself.' },
        { status: 400 }
      );
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId }
    });

    if (!targetUser) {
      return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
    }

    const updateData: { role?: 'ADMIN' | 'USER'; status?: 'ACTIVE' | 'SUSPENDED' } = {};
    if (role && (role === 'ADMIN' || role === 'USER')) {
      updateData.role = role;
    }
    if (status && (status === 'ACTIVE' || status === 'SUSPENDED')) {
      updateData.status = status;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid update parameters provided' }, { status: 400 });
    }

    const updatedUser = await prisma.user.update({
      where: { id: targetUserId },
      data: updateData
    });

    return NextResponse.json({
      success: true,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        role: updatedUser.role,
        status: updatedUser.status
      }
    });
  } catch (error) {
    console.error('Error updating user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
