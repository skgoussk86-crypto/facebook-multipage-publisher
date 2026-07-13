import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
  const approvedUsers = await prisma.user.count({ where: { approvalStatus: 'APPROVED' } });
  const pendingUsers = await prisma.user.count({ where: { approvalStatus: 'PENDING' } });
  const rejectedUsers = await prisma.user.count({ where: { approvalStatus: 'REJECTED' } });
  const approvedAdmins = await prisma.user.count({ where: { role: 'ADMIN', approvalStatus: 'APPROVED' } });
  
  // Directly query the DB using raw SQL to verify there are absolutely no nulls
  const rawNullCount = await prisma.$queryRawUnsafe<any[]>('SELECT COUNT(*) as count FROM "User" WHERE "approvalStatus" IS NULL');
  const nullApprovalStatus = Number(rawNullCount[0]?.count || 0);

  console.log('Total Users:', totalUsers);
  console.log('APPROVED Users:', approvedUsers);
  console.log('PENDING Users:', pendingUsers);
  console.log('REJECTED Users:', rejectedUsers);
  console.log('Approved ADMIN Users:', approvedAdmins);
  console.log('Users where approvalStatus is NULL:', nullApprovalStatus);
}

verify()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
