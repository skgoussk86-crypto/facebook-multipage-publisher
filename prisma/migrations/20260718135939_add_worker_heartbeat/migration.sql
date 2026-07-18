-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" UUID NOT NULL,
    "workerId" VARCHAR(255) NOT NULL,
    "startedAt" TIMESTAMPTZ NOT NULL,
    "lastPingAt" TIMESTAMPTZ NOT NULL,
    "currentStatus" VARCHAR(50) NOT NULL,
    "lastSuccessAt" TIMESTAMPTZ,
    "lastFailureAt" TIMESTAMPTZ,
    "lastError" TEXT,
    "jobsProcessedLastCycle" INTEGER NOT NULL DEFAULT 0,
    "nextPollEstimate" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkerHeartbeat_workerId_key"
ON "WorkerHeartbeat"("workerId");