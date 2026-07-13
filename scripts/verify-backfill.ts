import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Phase 1 Verification Audit ---');

  try {
    const tables = [
      { name: 'AppConfiguration', countAll: () => prisma.appConfiguration.count(), countWithUser: () => prisma.appConfiguration.count({ where: { userId: { not: null } } }), countWithoutUser: () => prisma.appConfiguration.count({ where: { userId: null } }) },
      { name: 'FacebookPage', countAll: () => prisma.facebookPage.count(), countWithUser: () => prisma.facebookPage.count({ where: { userId: { not: null } } }), countWithoutUser: () => prisma.facebookPage.count({ where: { userId: null } }) },
      { name: 'VideoJob', countAll: () => prisma.videoJob.count(), countWithUser: () => prisma.videoJob.count({ where: { userId: { not: null } } }), countWithoutUser: () => prisma.videoJob.count({ where: { userId: null } }) },
      { name: 'AuditLog', countAll: () => prisma.auditLog.count(), countWithUser: () => prisma.auditLog.count({ where: { userId: { not: null } } }), countWithoutUser: () => prisma.auditLog.count({ where: { userId: null } }) },
      { name: 'FacebookAccount', countAll: () => prisma.facebookAccount.count(), countWithUser: () => prisma.facebookAccount.count(), countWithoutUser: () => Promise.resolve(0) }
    ];

    let allValid = true;

    for (const table of tables) {
      const total = await table.countAll();
      const withUser = await table.countWithUser();
      const withoutUser = await table.countWithoutUser();

      console.log(`Table: ${table.name}`);
      console.log(`  - Total Rows: ${total}`);
      console.log(`  - With userId: ${withUser}`);
      console.log(`  - Without userId: ${withoutUser}`);

      if (withoutUser > 0) {
        console.warn(`  [WARNING] Table ${table.name} has ${withoutUser} records without a userId!`);
        allValid = false;
      } else {
        console.log(`  [OK] All records in ${table.name} successfully have a userId.`);
      }
    }

    // Double-check referential integrity
    const accountUserIds = (await prisma.facebookAccount.findMany({ select: { userId: true } })).map(a => a.userId);
    const pageUserIds = (await prisma.facebookPage.findMany({ select: { userId: true } })).map(p => p.userId);
    const jobUserIds = (await prisma.videoJob.findMany({ select: { userId: true } })).map(j => j.userId);
    const configUserIds = (await prisma.appConfiguration.findMany({ select: { userId: true } })).map(c => c.userId);

    const uniqueUserIds = Array.from(new Set([...accountUserIds, ...pageUserIds, ...jobUserIds, ...configUserIds]));
    
    console.log('\nReferential Integrity Check:');
    for (const uid of uniqueUserIds) {
      if (uid) {
        const userExists = await prisma.user.findUnique({ where: { id: uid } });
        if (!userExists) {
          console.error(`  [ERROR] Record references userId ${uid} but no such user exists in the User table!`);
          allValid = false;
        }
      }
    }

    if (allValid) {
      console.log('  [SUCCESS] All checks passed. Referential integrity is valid and no legacy records are orphaned.');
      process.exit(0);
    } else {
      console.log('  [FAILED] Some validation checks failed. Review details above.');
      process.exit(1);
    }
  } catch (error) {
    console.error('Audit script failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
