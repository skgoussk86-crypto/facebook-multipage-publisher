/*
  Warnings:

  - A unique constraint covering the columns `[userId,facebookUserId]` on the table `FacebookAccount` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,facebookPageId]` on the table `FacebookPage` will be added. If there are existing duplicate values, this will fail.
  - Made the column `userId` on table `FacebookPage` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "FacebookPage" DROP CONSTRAINT "FacebookPage_userId_fkey";

-- DropIndex
DROP INDEX "FacebookAccount_facebookUserId_key";

-- DropIndex
DROP INDEX "FacebookPage_facebookPageId_key";

-- AlterTable
ALTER TABLE "FacebookPage" ALTER COLUMN "userId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "FacebookAccount_userId_facebookUserId_key" ON "FacebookAccount"("userId", "facebookUserId");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookPage_userId_facebookPageId_key" ON "FacebookPage"("userId", "facebookPageId");

-- AddForeignKey
ALTER TABLE "FacebookPage" ADD CONSTRAINT "FacebookPage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
