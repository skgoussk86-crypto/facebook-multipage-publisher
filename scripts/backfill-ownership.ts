import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Phase 1: Database Promotion and Legacy Records Backfill ---');

  try {
    let adminUser = null;

    // 1. Check for environment variables to create or identify the admin
    const envEmail = process.env.ADMIN_EMAIL;
    const envPassword = process.env.ADMIN_PASSWORD;
    const envName = process.env.ADMIN_NAME || 'Meta Administrator';

    if (envEmail) {
      const normalizedEmail = envEmail.toLowerCase().trim();
      const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail }
      });

      if (existingUser) {
        console.log(`User with email "${normalizedEmail}" already exists. Promoting to ADMIN.`);
        adminUser = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            role: 'ADMIN',
            status: 'ACTIVE',
            name: existingUser.name || envName
          }
        });
      } else if (envPassword) {
        console.log(`Creating initial ADMIN account: ${normalizedEmail}`);
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(envPassword, salt);
        adminUser = await prisma.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            name: envName,
            role: 'ADMIN',
            status: 'ACTIVE'
          }
        });
      } else {
        console.error('ADMIN_EMAIL provided but ADMIN_PASSWORD is empty. Cannot create new admin.');
      }
    }

    // 2. Fallback: If no admin identified yet, find the first existing user in the database
    if (!adminUser) {
      const firstUser = await prisma.user.findFirst();
      if (!firstUser) {
        throw new Error('No users exist in the database, and no ADMIN_EMAIL environment variable was defined to create one.');
      }
      console.log(`No env configuration found. Promoting first database user "${firstUser.email}" to ADMIN.`);
      adminUser = await prisma.user.update({
        where: { id: firstUser.id },
        data: {
          role: 'ADMIN',
          status: 'ACTIVE',
          name: firstUser.name || envName
        }
      });
    }

    const adminId = adminUser.id;
    console.log(`Identified Administrator User ID: ${adminId} (${adminUser.email})`);

    // 3. AppConfiguration unique-constraint count safeguard
    const configCount = await prisma.appConfiguration.count();
    if (configCount > 1) {
      console.error(`[CRITICAL] Found ${configCount} existing AppConfiguration rows. Since AppConfiguration.userId is UNIQUE, backfilling multiple rows to a single admin will fail. Aborting backfill for safety.`);
      process.exit(1);
    }

    // 4. Backfill FacebookAccounts (userId is already required)
    const accounts = await prisma.facebookAccount.findMany();
    console.log(`Inspecting ${accounts.length} FacebookAccounts...`);
    for (const acc of accounts) {
      if (!acc.userId) {
        await prisma.facebookAccount.update({
          where: { id: acc.id },
          data: { userId: adminId }
        });
        console.log(`  - Linked FacebookAccount ID ${acc.id} (${acc.name}) to ADMIN.`);
      }
    }

    // 5. Backfill FacebookPages (derive ownership from related FacebookAccount)
    const pages = await prisma.facebookPage.findMany({
      include: { facebookAccount: true }
    });
    console.log(`Inspecting ${pages.length} FacebookPages...`);
    for (const page of pages) {
      if (!page.userId) {
        const targetUserId = page.facebookAccount?.userId || adminId;
        await prisma.facebookPage.update({
          where: { id: page.id },
          data: { userId: targetUserId }
        });
        console.log(`  - Linked FacebookPage ID ${page.id} (${page.pageName}) to User ${targetUserId}.`);
      }
    }

    // 6. Backfill VideoJobs (derive ownership from related FacebookPage)
    const jobs = await prisma.videoJob.findMany({
      include: { facebookPage: { include: { facebookAccount: true } } }
    });
    console.log(`Inspecting ${jobs.length} VideoJobs...`);
    for (const job of jobs) {
      if (!job.userId) {
        const targetUserId = job.facebookPage?.userId || job.facebookPage?.facebookAccount?.userId || adminId;
        await prisma.videoJob.update({
          where: { id: job.id },
          data: { userId: targetUserId }
        });
        console.log(`  - Linked VideoJob ID ${job.id} to User ${targetUserId}.`);
      }
    }

    // 7. Backfill AppConfigurations (assign to ADMIN if userId is null)
    const configs = await prisma.appConfiguration.findMany();
    console.log(`Inspecting ${configs.length} AppConfigurations...`);
    for (const config of configs) {
      if (!config.userId) {
        await prisma.appConfiguration.update({
          where: { id: config.id },
          data: { userId: adminId }
        });
        console.log(`  - Linked AppConfiguration (ID: ${config.id}) to ADMIN.`);
      }
    }

    // 8. Backfill AuditLogs (assign to ADMIN if userId is null)
    const logs = await prisma.auditLog.findMany();
    console.log(`Inspecting ${logs.length} AuditLogs...`);
    let logUpdateCount = 0;
    for (const log of logs) {
      if (!log.userId) {
        await prisma.auditLog.update({
          where: { id: log.id },
          data: { userId: adminId }
        });
        logUpdateCount++;
      }
    }
    if (logUpdateCount > 0) {
      console.log(`  - Linked ${logUpdateCount} orphaned AuditLogs to ADMIN.`);
    }

    console.log('[SUCCESS] Administrative credentials setup and legacy records backfill completed successfully.');
  } catch (error) {
    console.error('[ERROR] Backfill operation failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
