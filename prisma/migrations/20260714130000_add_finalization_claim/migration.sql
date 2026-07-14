-- CreateEnum
CREATE TYPE "UploadFinalizationOperation" AS ENUM ('COMPLETE', 'ABORT');

-- AlterTable
ALTER TABLE "UploadAsset"
  ADD COLUMN "finalizationOperation" "UploadFinalizationOperation",
  ADD COLUMN "finalizationLockToken" UUID,
  ADD COLUMN "finalizationLockedAt" TIMESTAMPTZ,
  ADD COLUMN "finalizationLockExpiresAt" TIMESTAMPTZ,
  ADD COLUMN "finalizationAttemptCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "UploadAsset_status_finalizationLockExpiresAt_idx" ON "UploadAsset"("status", "finalizationLockExpiresAt");
CREATE INDEX "UploadAsset_finalizationOperation_finalizationLockExpiresAt_idx" ON "UploadAsset"("finalizationOperation", "finalizationLockExpiresAt");

-- AddLockConsistencyCheck
ALTER TABLE "UploadAsset" ADD CONSTRAINT "UploadAsset_lock_consistency_check" CHECK (
  (
    "finalizationLockToken" IS NULL
    AND "finalizationLockedAt" IS NULL
    AND "finalizationLockExpiresAt" IS NULL
  )
  OR
  (
    "finalizationOperation" IS NOT NULL
    AND "finalizationLockToken" IS NOT NULL
    AND "finalizationLockedAt" IS NOT NULL
    AND "finalizationLockExpiresAt" IS NOT NULL
    AND "finalizationLockExpiresAt" > "finalizationLockedAt"
  )
);

-- AddAttemptCountCheck
ALTER TABLE "UploadAsset" ADD CONSTRAINT "UploadAsset_attempt_count_check" CHECK (
  "finalizationAttemptCount" >= 0
);
