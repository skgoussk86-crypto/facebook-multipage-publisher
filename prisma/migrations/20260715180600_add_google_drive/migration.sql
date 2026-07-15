-- AlterEnum
ALTER TYPE "StorageProvider" ADD VALUE 'GOOGLE_DRIVE';

-- CreateTable
CREATE TABLE "GoogleDriveConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "refreshTokenKeyVersion" VARCHAR(50) NOT NULL DEFAULT '1',
    "googleAccountEmail" VARCHAR(255),
    "driveFolderId" VARCHAR(255),
    "connectedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "GoogleDriveConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoogleDriveConnection_userId_key" ON "GoogleDriveConnection"("userId");

-- AddForeignKey
ALTER TABLE "GoogleDriveConnection" ADD CONSTRAINT "GoogleDriveConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
