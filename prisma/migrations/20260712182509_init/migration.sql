-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "facebookUserId" VARCHAR(255) NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMPTZ NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "FacebookAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookPage" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "facebookPageId" VARCHAR(255) NOT NULL,
    "pageName" VARCHAR(255) NOT NULL,
    "pageCategory" VARCHAR(255) NOT NULL,
    "pagePictureUrl" TEXT NOT NULL,
    "encryptedPageToken" TEXT NOT NULL,
    "isSynced" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "FacebookPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoJob" (
    "id" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "gcsVideoUri" TEXT NOT NULL,
    "gcsThumbnailUri" TEXT,
    "englishTitle" VARCHAR(255) NOT NULL,
    "englishCaption" TEXT NOT NULL,
    "hashtags" TEXT,
    "scheduledTimeUTC" TIMESTAMPTZ NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "metaPostId" VARCHAR(255),
    "cloudTaskName" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorLog" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookAccount_facebookUserId_key" ON "FacebookAccount"("facebookUserId");

-- CreateIndex
CREATE INDEX "FacebookAccount_facebookUserId_idx" ON "FacebookAccount"("facebookUserId");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookPage_facebookPageId_key" ON "FacebookPage"("facebookPageId");

-- CreateIndex
CREATE INDEX "FacebookPage_facebookPageId_idx" ON "FacebookPage"("facebookPageId");

-- CreateIndex
CREATE INDEX "VideoJob_status_idx" ON "VideoJob"("status");

-- CreateIndex
CREATE INDEX "VideoJob_scheduledTimeUTC_idx" ON "VideoJob"("scheduledTimeUTC");

-- CreateIndex
CREATE INDEX "VideoJob_pageId_idx" ON "VideoJob"("pageId");

-- AddForeignKey
ALTER TABLE "FacebookAccount" ADD CONSTRAINT "FacebookAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacebookPage" ADD CONSTRAINT "FacebookPage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FacebookAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoJob" ADD CONSTRAINT "VideoJob_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "FacebookPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
