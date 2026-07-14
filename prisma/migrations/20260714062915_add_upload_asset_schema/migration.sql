-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('R2');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('REQUESTED', 'UPLOADING', 'UPLOADED', 'VALIDATING', 'VALIDATED', 'FAILED', 'ABORTED', 'EXPIRED', 'OBJECT_DELETED');

-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN     "storageUri" TEXT,
ADD COLUMN     "uploadAssetId" UUID,
ALTER COLUMN "gcsVideoUri" DROP NOT NULL;

-- CreateTable
CREATE TABLE "UploadAsset" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "StorageProvider" NOT NULL DEFAULT 'R2',
    "bucket" VARCHAR(255) NOT NULL,
    "objectKey" VARCHAR(512) NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "expectedSize" BIGINT NOT NULL,
    "actualSize" BIGINT,
    "declaredMimeType" VARCHAR(100) NOT NULL,
    "detectedMimeType" VARCHAR(100),
    "checksum" VARCHAR(255),
    "objectETag" VARCHAR(255),
    "status" "UploadStatus" NOT NULL DEFAULT 'REQUESTED',
    "failureCode" VARCHAR(100),
    "failureMessage" TEXT,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "validationLockToken" UUID,
    "validationLockedAt" TIMESTAMPTZ,
    "validationLockExpiresAt" TIMESTAMPTZ,
    "validationAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "validationMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "validationStartedAt" TIMESTAMPTZ,
    "durationMs" INTEGER,
    "containerFormat" VARCHAR(50),
    "videoCodec" VARCHAR(50),
    "audioCodec" VARCHAR(50),
    "width" INTEGER,
    "height" INTEGER,
    "frameRate" DOUBLE PRECISION,
    "uploadExpiresAt" TIMESTAMPTZ NOT NULL,
    "uploadedAt" TIMESTAMPTZ,
    "validatedAt" TIMESTAMPTZ,
    "retentionUntil" TIMESTAMPTZ,
    "objectDeletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "UploadAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadAttempt" (
    "id" UUID NOT NULL,
    "uploadAssetId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" VARCHAR(50) NOT NULL,
    "errorLog" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "uploadAssetId" UUID NOT NULL,
    "encryptionKeyVersion" VARCHAR(50) NOT NULL,
    "encryptedProviderSessionId" TEXT NOT NULL,
    "encryptedCompletedParts" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "lastActivityAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("uploadAssetId")
);

-- CreateIndex
CREATE INDEX "UploadAsset_userId_status_idx" ON "UploadAsset"("userId", "status");

-- CreateIndex
CREATE INDEX "UploadAsset_status_uploadExpiresAt_idx" ON "UploadAsset"("status", "uploadExpiresAt");

-- CreateIndex
CREATE INDEX "UploadAsset_status_retentionUntil_idx" ON "UploadAsset"("status", "retentionUntil");

-- CreateIndex
CREATE INDEX "UploadAsset_status_validationLockExpiresAt_idx" ON "UploadAsset"("status", "validationLockExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadAsset_userId_idempotencyKey_key" ON "UploadAsset"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "UploadAsset_provider_bucket_objectKey_key" ON "UploadAsset"("provider", "bucket", "objectKey");

-- CreateIndex
CREATE INDEX "UploadAttempt_uploadAssetId_createdAt_idx" ON "UploadAttempt"("uploadAssetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadAttempt_uploadAssetId_attemptNumber_key" ON "UploadAttempt"("uploadAssetId", "attemptNumber");

-- CreateIndex
CREATE INDEX "VideoJob_uploadAssetId_idx" ON "VideoJob"("uploadAssetId");

-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_uploadAssetId_fkey" FOREIGN KEY ("uploadAssetId") REFERENCES "UploadAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadAsset" ADD CONSTRAINT "UploadAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadAttempt" ADD CONSTRAINT "UploadAttempt_uploadAssetId_fkey" FOREIGN KEY ("uploadAssetId") REFERENCES "UploadAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_uploadAssetId_fkey" FOREIGN KEY ("uploadAssetId") REFERENCES "UploadAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
