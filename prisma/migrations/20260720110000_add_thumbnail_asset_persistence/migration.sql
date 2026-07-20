-- CreateEnum
CREATE TYPE "ThumbnailSource" AS ENUM ('GEMINI_FRAME', 'MANUAL_FRAME', 'CUSTOM_UPLOAD');

-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN "thumbnailAssetId" UUID;

-- CreateTable
CREATE TABLE "ThumbnailAsset" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sourceUploadAssetId" UUID NOT NULL,
    "provider" "StorageProvider" NOT NULL DEFAULT 'GOOGLE_DRIVE',
    "bucket" VARCHAR(255) NOT NULL,
    "objectKey" VARCHAR(512) NOT NULL,
    "storageUri" TEXT NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" VARCHAR(255) NOT NULL,
    "source" "ThumbnailSource" NOT NULL,
    "timestampMs" INTEGER,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ThumbnailAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ThumbnailAsset_storageUri_key" ON "ThumbnailAsset"("storageUri");

-- CreateIndex
CREATE UNIQUE INDEX "ThumbnailAsset_provider_bucket_objectKey_key" ON "ThumbnailAsset"("provider", "bucket", "objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "ThumbnailAsset_userId_idempotencyKey_key" ON "ThumbnailAsset"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ThumbnailAsset_userId_deletedAt_idx" ON "ThumbnailAsset"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "ThumbnailAsset_sourceUploadAssetId_idx" ON "ThumbnailAsset"("sourceUploadAssetId");

-- CreateIndex
CREATE INDEX "VideoJob_thumbnailAssetId_idx" ON "VideoJob"("thumbnailAssetId");

-- AddForeignKey
ALTER TABLE "ThumbnailAsset" ADD CONSTRAINT "ThumbnailAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThumbnailAsset" ADD CONSTRAINT "ThumbnailAsset_sourceUploadAssetId_fkey" FOREIGN KEY ("sourceUploadAssetId") REFERENCES "UploadAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "ThumbnailAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
