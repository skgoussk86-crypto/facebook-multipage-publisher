import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import readline from 'readline';
import { Writable } from 'stream';

const prisma = new PrismaClient();

class MutedWritable extends Writable {
  public muted = false;

  override _write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.muted) {
      process.stdout.write(chunk, encoding);
    }
    callback();
  }
}

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askPassword(query: string): Promise<string> {
  return new Promise((resolve) => {
    const mutableStdout = new MutedWritable();
    mutableStdout.muted = false;

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true
    });

    process.stdout.write(query);
    mutableStdout.muted = true;

    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  // 1. Ensure running from local terminal only
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('\n[ERROR] This command must be run only from an interactive local terminal.\n');
    process.exit(1);
  }

  try {
    console.log('\n--- FB Multi-Page Publisher: Reset Administrator ---');

    // 2. Ask for existing admin email
    const existingEmailInput = await askQuestion('Enter existing administrator email: ');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(existingEmailInput)) {
      console.error('\n[ERROR] Invalid existing email format.\n');
      process.exit(1);
    }
    const existingEmail = existingEmailInput.toLowerCase().trim();

    // 3. Ask for new admin email
    const newEmailInput = await askQuestion('Enter new administrator email: ');
    if (!emailRegex.test(newEmailInput)) {
      console.error('\n[ERROR] Invalid new email format.\n');
      process.exit(1);
    }
    const newEmail = newEmailInput.toLowerCase().trim();

    // 4. Ask for new password
    const password = await askPassword('Enter new administrator password (min 12 characters): ');
    if (password.length < 12) {
      console.error('\n[ERROR] Password must be at least 12 characters long.\n');
      process.exit(1);
    }

    // 5. Ask for password confirmation
    const confirmPassword = await askPassword('Confirm new administrator password: ');
    if (password !== confirmPassword) {
      console.error('\n[ERROR] Passwords do not match.\n');
      process.exit(1);
    }

    // 6. Require a typed confirmation phrase before making changes
    console.log('\nWARNING: This operation will update the administrator credentials and invalidate all active sessions.');
    const typedConfirmation = await askQuestion('Type "RESET ADMIN" to confirm and apply changes: ');
    if (typedConfirmation !== 'RESET ADMIN') {
      console.error('\n[ERROR] Confirmation failed. Operation aborted.\n');
      process.exit(1);
    }

    console.log('\nVerifying administrator account...');

    // 7. Find the existing administrator
    const existingUser = await prisma.user.findUnique({
      where: { email: existingEmail },
    });

    if (!existingUser) {
      // Generic error if supplied email is not found
      console.error('\n[ERROR] Reset failed: Administrator email not found.\n');
      process.exit(1);
    }

    console.log('Hashing new password securely...');

    // 8. Hash password with bcryptjs
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    console.log('Updating database records...');

    // 9. Update only the selected existing administrator record and save to database
    // Invalidating sessions automatically because auth.ts verifies passwordHash & email
    const updatedUser = await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        email: newEmail,
        passwordHash,
      },
    });

    // 10. Add an audit log entry for the reset (without recording credentials, emails, passwords, hashes, tokens, or secrets)
    await prisma.auditLog.create({
      data: {
        action: 'RESET_ADMIN',
        details: 'Administrator credentials reset successfully, and active sessions invalidated.',
        userId: updatedUser.id,
      },
    });

    console.log(`\n[SUCCESS] Administrator credentials successfully updated. All active sessions have been invalidated.\n`);
  } catch (error) {
    console.error('\n[ERROR] Failed to reset administrator account:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
