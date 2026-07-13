-- CreateEnum
CREATE TYPE "UserApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "approvalStatus" "UserApprovalStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "approvedAt" TIMESTAMPTZ,
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "lastLoginAt" TIMESTAMPTZ,
ADD COLUMN     "registrationIp" VARCHAR(45),
ADD COLUMN     "rejectedAt" TIMESTAMPTZ,
ADD COLUMN     "rejectionReason" TEXT;

-- CreateIndex
CREATE INDEX "User_approvedById_idx" ON "User"("approvedById");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing accounts to APPROVED to prevent lockouts
UPDATE "User"
SET
  "approvalStatus" = 'APPROVED',
  "approvedAt" = COALESCE("approvedAt", CURRENT_TIMESTAMP);
