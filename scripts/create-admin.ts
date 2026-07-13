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
  try {
    // 1. Verify that no administrator already exists
    const adminCount = await prisma.user.count();
    if (adminCount > 0) {
      console.error('\n[ERROR] An administrator account already exists. Setup is already complete.\n');
      process.exit(1);
    }

    console.log('\n--- FB Multi-Page Publisher Setup: Create First Administrator ---');

    // 2. Ask for email
    const email = await askQuestion('Enter Admin Email: ');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.error('\n[ERROR] Invalid email format.\n');
      process.exit(1);
    }

    // 3. Ask for password and confirm password
    const password = await askPassword('Enter Admin Password (min 12 characters): ');
    if (password.length < 12) {
      console.error('\n[ERROR] Password must be at least 12 characters long.\n');
      process.exit(1);
    }

    const confirmPassword = await askPassword('Confirm Admin Password: ');
    if (password !== confirmPassword) {
      console.error('\n[ERROR] Passwords do not match.\n');
      process.exit(1);
    }

    console.log('\nCreating secure administrator account...');

    // 4. Hash password with bcryptjs
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // 5. Save to database
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
      },
    });

    console.log(`[SUCCESS] Administrator account successfully created for: ${user.email}\n`);
  } catch (error) {
    console.error('\n[ERROR] Failed to create administrator account:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
