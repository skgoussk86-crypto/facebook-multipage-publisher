BEGIN;

-- DO Block Mismatch and Backfill Guard
DO $$
DECLARE
  mismatches INTEGER;
  null_rows INTEGER;
  existing_jobs INTEGER;
BEGIN
  -- Scan for mismatched job/page/user ownership
  SELECT COUNT(*) INTO mismatches
  FROM "VideoJob" v
  JOIN "FacebookPage" p ON v."pageId" = p."id"
  WHERE v."userId" IS NOT NULL AND v."userId" <> p."userId";

  IF mismatches > 0 THEN
    RAISE EXCEPTION 'Aborting migration: Found % mismatched ownership rows between VideoJob and FacebookPage.', mismatches;
  END IF;

  -- Backfill userId from Page
  UPDATE "VideoJob" v
  SET "userId" = p."userId"
  FROM "FacebookPage" p
  WHERE v."pageId" = p."id" AND v."userId" IS NULL;

  -- Verify zero null rows remain
  SELECT COUNT(*) INTO null_rows
  FROM "VideoJob"
  WHERE "userId" IS NULL;

  IF null_rows > 0 THEN
    RAISE EXCEPTION 'Aborting migration: Found % rows with NULL userId after backfill.', null_rows;
  END IF;

  -- Check if any VideoJob rows exist before initializing attemptCount
  SELECT COUNT(*) INTO existing_jobs FROM "VideoJob";

  IF existing_jobs > 0 THEN
    RAISE EXCEPTION 'Aborting migration: Existing VideoJob rows detected (%). Manual check of status and retryCount semantics required.', existing_jobs;
  END IF;

END $$;

-- CreateEnum
CREATE TYPE "MockScenario" AS ENUM ('SUCCESS', 'TEMPORARY_NETWORK_FAILURE', 'META_PROCESSING_DELAY', 'META_RATE_LIMIT', 'INVALID_MEDIA_FORMAT', 'REVOKED_FACEBOOK_TOKEN', 'MISSING_FACEBOOK_PERMISSION', 'PERMANENT_PUBLISHING_FAILURE');

-- CreateEnum
CREATE TYPE "FailureClassification" AS ENUM ('NETWORK_ERROR', 'RATE_LIMIT', 'INVALID_MEDIA', 'REVOKED_TOKEN', 'MISSING_PERMISSION', 'UNKNOWN_ERROR');

-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'MEDIA_UPLOADED';
ALTER TYPE "JobStatus" ADD VALUE 'PREPARING';
ALTER TYPE "JobStatus" ADD VALUE 'UPLOADING_TO_META';
ALTER TYPE "JobStatus" ADD VALUE 'META_PROCESSING';
ALTER TYPE "JobStatus" ADD VALUE 'FAILED_RETRYABLE';
ALTER TYPE "JobStatus" ADD VALUE 'FAILED_PERMANENT';
ALTER TYPE "JobStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "JobStatus" ADD VALUE 'FACEBOOK_RECONNECT_REQUIRED';

-- AlterTable
ALTER TABLE "VideoJob" 
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "attempts" JSONB,
ADD COLUMN "contentType" VARCHAR(50) NOT NULL DEFAULT 'VIDEO',
ADD COLUMN "completedAt" TIMESTAMPTZ,
ADD COLUMN "failedAt" TIMESTAMPTZ,
ADD COLUMN "failureClassification" "FailureClassification",
ADD COLUMN "lastErrorCode" VARCHAR(255),
ADD COLUMN "lastErrorMessage" TEXT,
ADD COLUMN "lockExpiresAt" TIMESTAMPTZ,
ADD COLUMN "lockToken" UUID,
ADD COLUMN "lockedAt" TIMESTAMPTZ,
ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "mockScenario" "MockScenario",
ADD COLUMN "nextAttemptAt" TIMESTAMPTZ,
ADD COLUMN "providerProcessingId" TEXT,
ADD COLUMN "providerReference" TEXT,
ADD COLUMN "startedAt" TIMESTAMPTZ,
ALTER COLUMN "userId" SET NOT NULL;

COMMIT;
