-- CreateTable
CREATE TABLE "AppConfiguration" (
    "id" VARCHAR(50) NOT NULL DEFAULT 'default',
    "publicAppUrl" TEXT NOT NULL,
    "facebookAppId" VARCHAR(255) NOT NULL,
    "encryptedAppSecret" TEXT NOT NULL,
    "liveMetaMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AppConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "action" VARCHAR(255) NOT NULL,
    "details" TEXT NOT NULL,
    "ipAddress" VARCHAR(45),
    "userId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
