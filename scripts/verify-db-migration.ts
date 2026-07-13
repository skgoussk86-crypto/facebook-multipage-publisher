import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface NullApprovalStatusCount {
  count: bigint;
}

async function verify() {
  console.log('\n--- VERIFICATION A: Existing Users List ---');

  const users = await prisma.user.findMany({
    select: {
      email: true,
      role: true,
      status: true,
      approvalStatus: true,
      approvedAt: true,
      createdAt: true
    },
    orderBy: {
      createdAt: 'asc'
    }
  });

  console.log(JSON.stringify(users, null, 2));

  console.log('\n--- VERIFICATION B: Operational Counts ---');

  const totalUsers = await prisma.user.count();

  const approvedUsers = await prisma.user.count({
    where: {
      approvalStatus: 'APPROVED'
    }
  });

  const pendingUsers = await prisma.user.count({
    where: {
      approvalStatus: 'PENDING'
    }
  });

  const rejectedUsers = await prisma.user.count({
    where: {
      approvalStatus: 'REJECTED'
    }
  });

  const approvedAdmins = await prisma.user.count({
    where: {
      role: 'ADMIN',
      status: 'ACTIVE',
      approvalStatus: 'APPROVED'
    }
  });

  const rawNullCount =
    await prisma.$queryRaw<NullApprovalStatusCount[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "User"
      WHERE "approvalStatus" IS NULL
    `;

  const nullApprovalStatus = Number(
    rawNullCount[0]?.count ?? 0
  );

  console.log('Total Users:', totalUsers);
  console.log('APPROVED Users:', approvedUsers);
  console.log('PENDING Users:', pendingUsers);
  console.log('REJECTED Users:', rejectedUsers);
  console.log('Active and Approved ADMIN Users:', approvedAdmins);
  console.log(
    'Users where approvalStatus is NULL:',
    nullApprovalStatus
  );
}

verify()
  .catch((error: unknown) => {
    console.error('Database verification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });