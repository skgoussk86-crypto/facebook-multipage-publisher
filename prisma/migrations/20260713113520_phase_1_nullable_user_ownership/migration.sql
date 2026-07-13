-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- AlterTable
ALTER TABLE "AppConfiguration" ADD COLUMN     "userId" UUID;

-- AlterTable
ALTER TABLE "FacebookPage" ADD COLUMN     "userId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "name" VARCHAR(255),
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER',
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN     "userId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "AppConfiguration_userId_key" ON "AppConfiguration"("userId");

-- CreateIndex
CREATE INDEX "FacebookPage_userId_idx" ON "FacebookPage"("userId");

-- CreateIndex
CREATE INDEX "VideoJob_userId_idx" ON "VideoJob"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- AddForeignKey
ALTER TABLE "FacebookPage" ADD CONSTRAINT "FacebookPage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppConfiguration" ADD CONSTRAINT "AppConfiguration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
