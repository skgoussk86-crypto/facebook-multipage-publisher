-- AlterTable
ALTER TABLE "AppConfiguration" ADD COLUMN "configurationName" VARCHAR(100);
ALTER TABLE "AppConfiguration" ADD COLUMN "isDefault" BOOLEAN DEFAULT false;
ALTER TABLE "AppConfiguration" ADD COLUMN "isEnabled" BOOLEAN DEFAULT true;

-- Backfill owned configurations
UPDATE "AppConfiguration"
SET "configurationName" = 'Default Meta App',
    "isDefault" = true,
    "isEnabled" = true
WHERE "userId" IS NOT NULL;

-- Backfill unowned configurations
UPDATE "AppConfiguration"
SET "configurationName" = 'Unassigned Test Configuration',
    "isDefault" = false,
    "isEnabled" = false
WHERE "userId" IS NULL;

-- Make columns NOT NULL after backfill
ALTER TABLE "AppConfiguration" ALTER COLUMN "configurationName" SET NOT NULL;
ALTER TABLE "AppConfiguration" ALTER COLUMN "isDefault" SET NOT NULL;
ALTER TABLE "AppConfiguration" ALTER COLUMN "isEnabled" SET NOT NULL;

-- Add nullable appConfigurationId to FacebookAccount initially
ALTER TABLE "FacebookAccount" ADD COLUMN "appConfigurationId" VARCHAR(50);

-- Pre-backfill Assertion DO block: validate ownership configuration count
DO $$
DECLARE
    invalid_owner_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO invalid_owner_count
    FROM (
      SELECT DISTINCT fa."userId"
      FROM "FacebookAccount" fa
      WHERE (
        SELECT COUNT(*)
        FROM "AppConfiguration" ac
        WHERE ac."userId" = fa."userId"
      ) <> 1
    ) sub;

    IF invalid_owner_count > 0 THEN
        RAISE EXCEPTION 'Assertion failed: % FacebookAccount owners do not have exactly one AppConfiguration.', invalid_owner_count;
    END IF;
END $$;

-- Perform the FacebookAccount backfill only after that ownership assertion succeeds
UPDATE "FacebookAccount" fa
SET "appConfigurationId" = ac.id
FROM "AppConfiguration" ac
WHERE fa."userId" = ac."userId";

-- Retain a separate post-backfill assertion that no FacebookAccount.appConfigurationId remains NULL
DO $$
DECLARE
    null_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO null_count FROM "FacebookAccount" WHERE "appConfigurationId" IS NULL;
    IF null_count > 0 THEN
        RAISE EXCEPTION 'Assertion failed: % FacebookAccount records lack appConfigurationId.', null_count;
    END IF;
END $$;

-- Make appConfigurationId NOT NULL
ALTER TABLE "FacebookAccount" ALTER COLUMN "appConfigurationId" SET NOT NULL;

-- Reconcile the old AppConfiguration ID database default with the new Prisma schema
ALTER TABLE "AppConfiguration" ALTER COLUMN "id" DROP DEFAULT;

-- Drop old unique indexes
DROP INDEX IF EXISTS "AppConfiguration_userId_key";
DROP INDEX IF EXISTS "FacebookAccount_userId_facebookUserId_key";
DROP INDEX IF EXISTS "FacebookPage_userId_facebookPageId_key";

-- Create new unique indexes and indexes
CREATE UNIQUE INDEX "AppConfiguration_userId_facebookAppId_key" ON "AppConfiguration"("userId", "facebookAppId");
CREATE INDEX "AppConfiguration_userId_isDefault_idx" ON "AppConfiguration"("userId", "isDefault");
CREATE INDEX "AppConfiguration_userId_isEnabled_idx" ON "AppConfiguration"("userId", "isEnabled");

CREATE UNIQUE INDEX "FacebookAccount_appConfigurationId_facebookUserId_key" ON "FacebookAccount"("appConfigurationId", "facebookUserId");
CREATE INDEX "FacebookAccount_appConfigurationId_idx" ON "FacebookAccount"("appConfigurationId");
CREATE INDEX "FacebookAccount_userId_facebookUserId_idx" ON "FacebookAccount"("userId", "facebookUserId");

CREATE UNIQUE INDEX "FacebookPage_accountId_facebookPageId_key" ON "FacebookPage"("accountId", "facebookPageId");

-- Add foreign key constraint
ALTER TABLE "FacebookAccount" ADD CONSTRAINT "FacebookAccount_appConfigurationId_fkey"
FOREIGN KEY ("appConfigurationId") REFERENCES "AppConfiguration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
