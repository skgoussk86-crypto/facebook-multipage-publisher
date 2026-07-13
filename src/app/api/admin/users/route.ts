import { NextRequest, NextResponse } from 'next/server';
import {
  Prisma,
  UserApprovalStatus,
  UserRole,
  UserStatus
} from '@prisma/client';
import { prisma } from '@/lib/prisma-client';
import { verifyAdminSession, verifyAdminRole } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const currentUser = await verifyAdminSession(request);

    if (!currentUser) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    if (!verifyAdminRole(currentUser)) {
      return NextResponse.json(
        { error: 'Forbidden: Admin role required' },
        { status: 403 }
      );
    }

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        approvalStatus: true,
        approvedAt: true,
        approvedById: true,
        rejectedAt: true,
        rejectionReason: true,
        registrationIp: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({
      success: true,
      users
    });
  } catch (error) {
    console.error('Error listing users:', error);

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const currentUser = await verifyAdminSession(request);

    if (!currentUser) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    if (!verifyAdminRole(currentUser)) {
      return NextResponse.json(
        { error: 'Forbidden: Admin role required' },
        { status: 403 }
      );
    }

    const body = await request.json();

    const {
      targetUserId,
      role,
      status,
      approvalStatus,
      rejectionReason
    } = body || {};

    if (!targetUserId || typeof targetUserId !== 'string') {
      return NextResponse.json(
        { error: 'Target User ID is required' },
        { status: 400 }
      );
    }

    if (targetUserId === currentUser.id) {
      return NextResponse.json(
        {
          error:
            'You cannot change your own role, account status, or approval status.'
        },
        { status: 400 }
      );
    }

    const targetUser = await prisma.user.findUnique({
      where: {
        id: targetUserId
      }
    });

    if (!targetUser) {
      return NextResponse.json(
        { error: 'Target user not found' },
        { status: 404 }
      );
    }

    if (
      role !== undefined &&
      role !== UserRole.ADMIN &&
      role !== UserRole.USER
    ) {
      return NextResponse.json(
        { error: 'Invalid user role' },
        { status: 400 }
      );
    }

    if (
      status !== undefined &&
      status !== UserStatus.ACTIVE &&
      status !== UserStatus.SUSPENDED
    ) {
      return NextResponse.json(
        { error: 'Invalid account status' },
        { status: 400 }
      );
    }

    if (
      approvalStatus !== undefined &&
      approvalStatus !== UserApprovalStatus.PENDING &&
      approvalStatus !== UserApprovalStatus.APPROVED &&
      approvalStatus !== UserApprovalStatus.REJECTED
    ) {
      return NextResponse.json(
        { error: 'Invalid approval status' },
        { status: 400 }
      );
    }

    if (
      role === undefined &&
      status === undefined &&
      approvalStatus === undefined
    ) {
      return NextResponse.json(
        { error: 'No valid update parameters provided' },
        { status: 400 }
      );
    }

    const resultingRole = role ?? targetUser.role;
    const resultingStatus = status ?? targetUser.status;
    const resultingApprovalStatus =
      approvalStatus ?? targetUser.approvalStatus;

    const targetIsUsableAdmin =
      targetUser.role === UserRole.ADMIN &&
      targetUser.status === UserStatus.ACTIVE &&
      targetUser.approvalStatus === UserApprovalStatus.APPROVED;

    const targetWillRemainUsableAdmin =
      resultingRole === UserRole.ADMIN &&
      resultingStatus === UserStatus.ACTIVE &&
      resultingApprovalStatus === UserApprovalStatus.APPROVED;

    if (targetIsUsableAdmin && !targetWillRemainUsableAdmin) {
      const usableAdminCount = await prisma.user.count({
        where: {
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
          approvalStatus: UserApprovalStatus.APPROVED
        }
      });

      if (usableAdminCount <= 1) {
        return NextResponse.json(
          {
            error:
              'This action is blocked because the system must retain at least one active and approved administrator.'
          },
          { status: 400 }
        );
      }
    }

    const updateData: Prisma.UserUncheckedUpdateInput = {};

    if (role !== undefined) {
      updateData.role = role;
    }

    if (status !== undefined) {
      updateData.status = status;
    }

    if (approvalStatus === UserApprovalStatus.APPROVED) {
      updateData.approvalStatus = UserApprovalStatus.APPROVED;
      updateData.approvedAt = new Date();
      updateData.approvedById = currentUser.id;
      updateData.rejectedAt = null;
      updateData.rejectionReason = null;
    }

    if (approvalStatus === UserApprovalStatus.REJECTED) {
      const cleanReason =
        typeof rejectionReason === 'string'
          ? rejectionReason.trim()
          : '';

      if (!cleanReason) {
        return NextResponse.json(
          {
            error: 'A rejection reason is required.'
          },
          { status: 400 }
        );
      }

      if (cleanReason.length > 1000) {
        return NextResponse.json(
          {
            error:
              'Rejection reason must not exceed 1000 characters.'
          },
          { status: 400 }
        );
      }

      updateData.approvalStatus = UserApprovalStatus.REJECTED;
      updateData.approvedAt = null;
      updateData.approvedById = null;
      updateData.rejectedAt = new Date();
      updateData.rejectionReason = cleanReason;
    }

    if (approvalStatus === UserApprovalStatus.PENDING) {
      updateData.approvalStatus = UserApprovalStatus.PENDING;
      updateData.approvedAt = null;
      updateData.approvedById = null;
      updateData.rejectedAt = null;
      updateData.rejectionReason = null;
    }

    const updatedUser = await prisma.user.update({
      where: {
        id: targetUserId
      },
      data: updateData,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        approvalStatus: true,
        approvedAt: true,
        approvedById: true,
        rejectedAt: true,
        rejectionReason: true,
        registrationIp: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return NextResponse.json({
      success: true,
      user: updatedUser
    });
  } catch (error) {
    console.error('Error updating user:', error);

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}