import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface DuplicateFacebookAccount {
  userId: string;
  facebookUserId: string;
  duplicateCount: bigint;
}

interface DuplicateFacebookPage {
  userId: string;
  facebookPageId: string;
  duplicateCount: bigint;
}

interface NullOwnershipCounts {
  facebookAccountNullUserIds: bigint;
  facebookPageNullUserIds: bigint;
}

async function main() {
  console.log('--- Multi-User Ownership Verification Audit ---');

  let criticalChecksPassed = true;

  const [
    totalUsers,
    totalFacebookAccounts,
    totalFacebookPages,
    totalVideoJobs,
    totalAppConfigurations,
    totalAuditLogs
  ] = await Promise.all([
    prisma.user.count(),
    prisma.facebookAccount.count(),
    prisma.facebookPage.count(),
    prisma.videoJob.count(),
    prisma.appConfiguration.count(),
    prisma.auditLog.count()
  ]);

  console.log('\nDatabase Row Counts:');
  console.log(`  - Users: ${totalUsers}`);
  console.log(`  - Facebook Accounts: ${totalFacebookAccounts}`);
  console.log(`  - Facebook Pages: ${totalFacebookPages}`);
  console.log(`  - Video Jobs: ${totalVideoJobs}`);
  console.log(`  - App Configurations: ${totalAppConfigurations}`);
  console.log(`  - Audit Logs: ${totalAuditLogs}`);

  const nullOwnershipCounts =
    await prisma.$queryRaw<NullOwnershipCounts[]>`
      SELECT
        (
          SELECT COUNT(*)::bigint
          FROM "FacebookAccount"
          WHERE "userId" IS NULL
        ) AS "facebookAccountNullUserIds",
        (
          SELECT COUNT(*)::bigint
          FROM "FacebookPage"
          WHERE "userId" IS NULL
        ) AS "facebookPageNullUserIds"
    `;

  const facebookAccountNullUserIds = Number(
    nullOwnershipCounts[0]?.facebookAccountNullUserIds ?? 0
  );

  const facebookPageNullUserIds = Number(
    nullOwnershipCounts[0]?.facebookPageNullUserIds ?? 0
  );

  console.log('\nRequired Ownership Checks:');
  console.log(
    `  - FacebookAccount rows without userId: ${facebookAccountNullUserIds}`
  );
  console.log(
    `  - FacebookPage rows without userId: ${facebookPageNullUserIds}`
  );

  if (
    facebookAccountNullUserIds > 0 ||
    facebookPageNullUserIds > 0
  ) {
    console.error(
      '  [ERROR] Required Facebook ownership records are missing userId.'
    );

    criticalChecksPassed = false;
  } else {
    console.log(
      '  [OK] All Facebook accounts and pages have required user ownership.'
    );
  }

  const pages = await prisma.facebookPage.findMany({
    select: {
      id: true,
      facebookPageId: true,
      userId: true,
      facebookAccount: {
        select: {
          id: true,
          userId: true
        }
      }
    }
  });

  const ownershipMismatches = pages.filter(
    (page) =>
      page.userId !== page.facebookAccount.userId
  );

  console.log('\nFacebook Page and Account Ownership Consistency:');

  if (ownershipMismatches.length > 0) {
    console.error(
      `  [ERROR] Found ${ownershipMismatches.length} Facebook page records whose userId does not match their parent Facebook account.`
    );

    for (const page of ownershipMismatches) {
      console.error(
        `    Page ${page.facebookPageId}: page userId=${page.userId}, account userId=${page.facebookAccount.userId}`
      );
    }

    criticalChecksPassed = false;
  } else {
    console.log(
      '  [OK] Every Facebook page belongs to an account owned by the same application user.'
    );
  }

  const duplicateFacebookAccounts =
    await prisma.$queryRaw<DuplicateFacebookAccount[]>`
      SELECT
        "userId",
        "facebookUserId",
        COUNT(*)::bigint AS "duplicateCount"
      FROM "FacebookAccount"
      GROUP BY "userId", "facebookUserId"
      HAVING COUNT(*) > 1
    `;

  const duplicateFacebookPages =
    await prisma.$queryRaw<DuplicateFacebookPage[]>`
      SELECT
        "userId",
        "facebookPageId",
        COUNT(*)::bigint AS "duplicateCount"
      FROM "FacebookPage"
      GROUP BY "userId", "facebookPageId"
      HAVING COUNT(*) > 1
    `;

  console.log('\nCompound Uniqueness Checks:');

  if (duplicateFacebookAccounts.length > 0) {
    console.error(
      `  [ERROR] Found ${duplicateFacebookAccounts.length} duplicate per-user Facebook account identifiers.`
    );

    criticalChecksPassed = false;
  } else {
    console.log(
      '  [OK] No duplicate userId + facebookUserId combinations found.'
    );
  }

  if (duplicateFacebookPages.length > 0) {
    console.error(
      `  [ERROR] Found ${duplicateFacebookPages.length} duplicate per-user Facebook page identifiers.`
    );

    criticalChecksPassed = false;
  } else {
    console.log(
      '  [OK] No duplicate userId + facebookPageId combinations found.'
    );
  }

  const [
    appConfigurationsWithoutUser,
    videoJobsWithoutUser,
    auditLogsWithoutUser
  ] = await Promise.all([
    prisma.appConfiguration.count({
      where: {
        userId: null
      }
    }),
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint as count FROM "VideoJob" WHERE "userId" IS NULL`.then(res => Number(res[0]?.count || 0)),
    prisma.auditLog.count({
      where: {
        userId: null
      }
    })
  ]);

  console.log('\nLegacy Optional Ownership Records:');
  console.log(
    `  - AppConfiguration rows without userId: ${appConfigurationsWithoutUser}`
  );
  console.log(
    `  - VideoJob rows without userId: ${videoJobsWithoutUser}`
  );
  console.log(
    `  - AuditLog rows without userId: ${auditLogsWithoutUser}`
  );

  if (
    appConfigurationsWithoutUser > 0 ||
    videoJobsWithoutUser > 0 ||
    auditLogsWithoutUser > 0
  ) {
    console.warn(
      '  [WARNING] Optional legacy records without userId still exist. They were not deleted because they may contain historical data.'
    );
  } else {
    console.log(
      '  [OK] No optional ownership records are missing userId.'
    );
  }

  const referencedUserIds = new Set<string>();

  const [
    accountOwners,
    pageOwners,
    jobOwners,
    configurationOwners,
    auditLogOwners
  ] = await Promise.all([
    prisma.facebookAccount.findMany({
      select: {
        userId: true
      }
    }),
    prisma.facebookPage.findMany({
      select: {
        userId: true
      }
    }),
    prisma.$queryRaw<Array<{ userId: string }>>`SELECT "userId" FROM "VideoJob" WHERE "userId" IS NOT NULL`,
    prisma.appConfiguration.findMany({
      where: {
        userId: {
          not: null
        }
      },
      select: {
        userId: true
      }
    }),
    prisma.auditLog.findMany({
      where: {
        userId: {
          not: null
        }
      },
      select: {
        userId: true
      }
    })
  ]);

  for (const record of accountOwners) {
    referencedUserIds.add(record.userId);
  }

  for (const record of pageOwners) {
    referencedUserIds.add(record.userId);
  }

  for (const record of jobOwners) {
    if (record.userId) {
      referencedUserIds.add(record.userId);
    }
  }

  for (const record of configurationOwners) {
    if (record.userId) {
      referencedUserIds.add(record.userId);
    }
  }

  for (const record of auditLogOwners) {
    if (record.userId) {
      referencedUserIds.add(record.userId);
    }
  }

  console.log('\nReferenced User Integrity Check:');

  for (const userId of referencedUserIds) {
    const userExists = await prisma.user.findUnique({
      where: {
        id: userId
      },
      select: {
        id: true
      }
    });

    if (!userExists) {
      console.error(
        `  [ERROR] A record references missing userId ${userId}.`
      );

      criticalChecksPassed = false;
    }
  }

  if (criticalChecksPassed) {
    console.log(
      '  [SUCCESS] All critical multi-user ownership and isolation checks passed.'
    );
  } else {
    console.error(
      '  [FAILED] One or more critical ownership checks failed.'
    );

    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('Ownership verification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });