# Phase 3 Implementation Plan: Publishing Job State Machine & Local Mock Queue Worker

This plan defines the architecture, database migrations, state transitions, queue worker, concurrency lease logic, API design, testing coverage, and UI integration for Phase 3.

---

## 1. Existing Relevant Architecture and Files
* **Database & ORM**: PostgreSQL database with Prisma client. The `VideoJob` table is mapped in [prisma/schema.prisma](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/prisma/schema.prisma). It currently contains fields for target `pageId`, UTC schedule time `scheduledTimeUTC`, status `JobStatus` (`DRAFT`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `FAILED`), and basic telemetry (`retryCount`, `errorLog`). It has a nullable `userId` and a User relation.
* **Authentication Helpers**: The following actual helpers exist in [src/lib/auth.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/lib/auth.ts):
  - `getSessionUser()`: Reads session cookie, retrieves user, and validates that `status === 'ACTIVE'` and `approvalStatus === 'APPROVED'`. Normal approved users are not required to be administrators.
  - `verifyAdminSession(request)`: Checks session cookie, verifies CSRF headers, and returns the User object. Used for mutations.
  - `verifyAdminRole(user)`: Checks if `user.role === 'ADMIN'`. Used to gate admin-only API routes.
* **Frontend**: [src/app/DashboardClient.tsx](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/DashboardClient.tsx) is a Tailwind SPA that manages mock jobs in local React state and includes a Diagnostics Inspector and Simulation Log console.

---

## 2. Complete Exact List of Modified and Created Files
Before creating or modifying any file, Antigravity will check if the file already exists and extend it rather than overwrite it.

### Existing Files to Modify:
1. **[prisma/schema.prisma](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/prisma/schema.prisma)**: Add enum values to `JobStatus`, introduce `MockScenario` and `FailureClassification` enums, update `VideoJob` model with tracking, lock/lease, and lifecycle columns.
2. **[src/lib/db.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/lib/db.ts)**: Implement secure database CRUD helpers for jobs with strict owner boundaries.
3. **[src/app/DashboardClient.tsx](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/DashboardClient.tsx)**: Modify hooks to load data from server routes, bind Confirm Scheduling to database persistence, and tie action buttons (Cancel, Retry, Worker trigger) to backend API requests.

### New Files to Create:
1. **[phase-3-state-machine-plan.md](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/phase-3-state-machine-plan.md)**: This planning file (at project root).
2. **[prisma/migrations/20260713203000_add_publishing_job_state_fields/migration.sql](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/prisma/migrations/20260713203000_add_publishing_job_state_fields/migration.sql)**: Hand-crafted SQL migration.
3. **[src/lib/job-state-machine.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/lib/job-state-machine.ts)**: Central transition service. All status writes, claiming, lock-cleanup, and resumes MUST pass through this helper; routes and UI are blocked from directly assigning statuses.
4. **[src/lib/job-worker.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/lib/job-worker.ts)**: Core background worker runner (performs mock processing scenario step logs, lease management, and resumes).
5. **[src/lib/validation.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/lib/validation.ts)**: Input validation rules for job creation.
6. **[src/app/api/facebook/jobs/route.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/api/facebook/jobs/route.ts)**: Handles owned job list (`GET`) and bulk creation (`POST`).
7. **[src/app/api/facebook/jobs/[id]/route.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/api/facebook/jobs/[id]/route.ts)**: Returns single job details (`GET`).
8. **[src/app/api/facebook/jobs/[id]/cancel/route.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/api/facebook/jobs/[id]/cancel/route.ts)**: Aborts a pre-provider job, setting it to `CANCELLED` (`POST`).
9. **[src/app/api/facebook/jobs/[id]/retry/route.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/api/facebook/jobs/[id]/retry/route.ts)**: Re-queues a failed/expired job by transitioning status to `SCHEDULED` (`POST`).
10. **[src/app/api/facebook/jobs/[id]/trigger/route.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/api/facebook/jobs/[id]/trigger/route.ts)**: Endpoint to run queue worker for a single job instantly (`POST`).
11. **[src/app/api/admin/worker/route.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/src/app/api/admin/worker/route.ts)**: Admin endpoint triggering processing of eligible queued jobs (`POST`).
12. **[scripts/run-phase3-tests.ts](file:///c:/Users/HP/OneDrive/Desktop/facebook-multipage-publisher/scripts/run-phase3-tests.ts)**: Suite of E2E integration tests.

---

## 4. Additive Prisma Enum and Model Changes

### A. JobStatus Enum (Preserving legacy FAILED)
```prisma
enum JobStatus {
  DRAFT
  MEDIA_UPLOADED
  SCHEDULED
  PREPARING
  UPLOADING_TO_META
  META_PROCESSING
  PUBLISHING
  PUBLISHED
  FAILED_RETRYABLE
  FAILED_PERMANENT
  CANCELLED
  FACEBOOK_RECONNECT_REQUIRED
  /// Legacy terminal status. New code must never write this value.
  FAILED
}
```

### B. Additive Enums
```prisma
enum MockScenario {
  SUCCESS
  TEMPORARY_NETWORK_FAILURE
  META_PROCESSING_DELAY
  META_RATE_LIMIT
  INVALID_MEDIA_FORMAT
  REVOKED_FACEBOOK_TOKEN
  MISSING_FACEBOOK_PERMISSION
  PERMANENT_PUBLISHING_FAILURE
}

enum FailureClassification {
  NETWORK_ERROR
  RATE_LIMIT
  INVALID_MEDIA
  REVOKED_TOKEN
  MISSING_PERMISSION
  UNKNOWN_ERROR
}
```

### C. VideoJob Model Changes
`retryCount` is preserved as a legacy compatibility field. `attemptCount` is added as the active total processing counter.
```prisma
model VideoJob {
  // ... existing fields ...
  userId                String                @db.Uuid // Kept. Set non-null after verification.
  user                  User                  @relation(fields: [userId], references: [id])
  
  // Tracking fields
  maxAttempts           Int                   @default(3) @db.Integer
  attemptCount          Int                   @default(0) @db.Integer // Total attempts made
  lastErrorCode         String?               @db.VarChar(255)
  lastErrorMessage      String?               @db.Text
  failureClassification FailureClassification?
  providerReference     String?               @db.Text // Meta upload session reference
  providerProcessingId  String?               @db.Text // Meta video/reel ID reference
  mockScenario          MockScenario?
  
  // Lease / Lock fields
  lockToken             String?               @db.Uuid
  lockedAt              DateTime?             @db.Timestamptz
  lockExpiresAt         DateTime?             @db.Timestamptz
  nextAttemptAt         DateTime?             @db.Timestamptz
  
  // Lifecycle timestamps
  startedAt             DateTime?             @db.Timestamptz
  completedAt           DateTime?             @db.Timestamptz
  failedAt              DateTime?             @db.Timestamptz

  @@index([status])
  @@index([scheduledTimeUTC])
  @@index([pageId])
  @@index([userId])
}
```

---

## 5. Safe Migration Strategy
1. **No direct `migrate dev` execution**: The migration SQL will be generated manually using `prisma migrate diff` comparing schema state without modifying the database.
2. **PostgreSQL DO block Mismatch Guard**:
   - The SQL script wraps the check and alterations inside a transaction block:
     ```sql
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
         -- Abort. Migration deployment must stop until retryCount semantics and each status are reviewed.
         RAISE EXCEPTION 'Aborting migration: Existing VideoJob rows detected (%). Manual check of status and retryCount semantics required.', existing_jobs;
       ELSE
         -- If zero rows exist, leave attemptCount at its default 0.
         -- Existing retryCount must remain unchanged. No guessed attemptCount mapping is permitted.
         NULL;
       END IF;

     END $$;
     ```
   - If the assertions succeed, the script alters the existing nullable `userId` to `NOT NULL` and creates foreign key indices.
3. **Application**: Applied via `npx.cmd prisma migrate deploy` only after explicit administrator review and approval.

---

## 6. Allowed State Transitions
All writes must pass through the **Central Transition Service** (`src/lib/job-state-machine.ts`). The allowed transitions are:

* **`DRAFT`** $\rightarrow$ `MEDIA_UPLOADED`, `SCHEDULED`, `CANCELLED`
* **`MEDIA_UPLOADED`** $\rightarrow$ `SCHEDULED`, `CANCELLED`
* **`SCHEDULED`** $\rightarrow$ `PREPARING`, `CANCELLED`
* **`PREPARING`** $\rightarrow$ `UPLOADING_TO_META`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `FACEBOOK_RECONNECT_REQUIRED`, `CANCELLED`
* **`UPLOADING_TO_META`** $\rightarrow$ `META_PROCESSING`, `PUBLISHING`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `FACEBOOK_RECONNECT_REQUIRED`
* **`META_PROCESSING`** $\rightarrow$ `PUBLISHING`, `PUBLISHED`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `FACEBOOK_RECONNECT_REQUIRED`
* **`PUBLISHING`** $\rightarrow$ `PUBLISHED`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `FACEBOOK_RECONNECT_REQUIRED`
* **`FAILED_RETRYABLE`** $\rightarrow$ `SCHEDULED` (via Retry API), `CANCELLED`
* **`FACEBOOK_RECONNECT_REQUIRED`** $\rightarrow$ `SCHEDULED` (Guarded: permitted only after successful verification of account connectivity, page ownership, page token decryption, and required Graph API publishing permissions).

---

## 7. Rejected State Transitions
Any status mutation not matching the allowed matrix will fail. Explicitly:
1. **Terminal remains Terminal**: `PUBLISHED`, `CANCELLED`, `FAILED_PERMANENT`, and legacy `FAILED` are terminal states and can never transition back to `SCHEDULED` or `PREPARING`.
2. **Post-provider Cancellation Lock**: Cancel is restricted to safe pre-provider states (`DRAFT`, `MEDIA_UPLOADED`, `SCHEDULED`, `PREPARING` before upload, and `FAILED_RETRYABLE`). Jobs in `UPLOADING_TO_META`, `META_PROCESSING`, or `PUBLISHING` cannot be cancelled.

---

## 8. Job Ownership and Facebook Page Ownership Validation
* **Session Scope**: API routes call `verifyAdminSession(request)` to fetch the user.
* **Isolation**: Database select / write commands restrict queries to `userId = sessionUser.id`.
* **Page validation**: When a job is created, the system checks that the `pageId` belongs to a page owned by `sessionUser.id`. If not, it rejects with a `400 Bad Request`.

---

## 9. Worker Concurrency, Locking, & Fencing Strategy

### A. Atomic Worker Claims
* Normal worker claims process only jobs matching:
  - `status = SCHEDULED`
  - `scheduledTimeUTC <= current UTC time`
  - `attemptCount < maxAttempts` (where the condition is dynamically set as field-to-field limit: `attemptCount < maxAttempts` in raw SQL or Prisma update filter)
  - lock is absent (`lockExpiresAt IS NULL`) or expired (`lockExpiresAt < current UTC time`).
* If an inconsistent scheduled job with `attemptCount >= maxAttempts` is found, the state-machine service moves it directly to `FAILED_PERMANENT` and records an audit log.
* The claim transitions the status to `PREPARING`, sets `startedAt`, sets a new `lockToken` (UUID), sets `lockExpiresAt` (10 mins lease), and increments `attemptCount` by 1.
* Status check, due-time check, attempt-limit check, increment, `PREPARING` transition, lease creation, and audit log must run as a single atomic database transaction.

### B. State-Specific Expired-Lease Recovery
Expired active lease recovery checks all leased active states where `lockExpiresAt < NOW()` and handles them contextually:
* **`PREPARING`**: Classify the already-counted attempt as failed (do not increment `attemptCount` again). If `attemptCount >= maxAttempts`, transitions to `FAILED_PERMANENT`, else `FAILED_RETRYABLE`.
* **`UPLOADING_TO_META`**: Reconcile using `providerReference` before deciding whether to resume or fail.
* **`PUBLISHING`**: Reconcile using `providerProcessingId` before any retry so duplicate publishing cannot occur.
* **`META_PROCESSING`**: Reclaim the expired lease and resume provider-status polling; do not automatically convert it to `FAILED_RETRYABLE`.
* **Reconciliation Failure**: If reconciliation cannot prove a safe retry in future live Meta mode, the job transitions to a secure failure/manual-review state (e.g. `FAILED_PERMANENT`) with detailed diagnostics, rather than risking duplicate publication.

### C. Atomic Resumption (`META_PROCESSING` Resumption)
* Separate claim for `META_PROCESSING` resumes where `nextAttemptAt <= NOW()` and lock is absent/expired.
* Resuming `META_PROCESSING` check does not increment `attemptCount` and does not restart upload unless a new attempt starts.
* Clears lease fields on every completed, failed, reconnect-required, cancelled, or rescheduled outcome.

### D. Stale-Worker Fencing
* Every write transaction must match the current lease:
  `where: { id: jobId, lockToken: workerUuid, lockExpiresAt: { gt: new Date() } }`.
* Stale worker instances whose lease has expired cannot write, even if no newer worker has claimed it.
* A new claim always generates a new `lockToken`.
* Atomic fencing and transition logic must remain inside the central state-machine service.

---

## 10. Manual Trigger Path
* Owner-authorized manual trigger allows immediate scheduling and execution.
* May ignore `scheduledTimeUTC` only after explicit owner authorization.
* Enforces `attemptCount < maxAttempts`, eligible status, ownership, account approval, locking, fencing, and audit logging. It must not bypass the central state-machine transition service.

---

## 11. Attempt Counting Semantics
* `attemptCount`: Increments by 1 only when transitioning from `SCHEDULED` $\rightarrow$ `PREPARING` (starts at 0, max = 3).
* `maxAttempts`: 3 attempts total.

---

## 12. Failure Classifications
* maps to `FailureClassification` enum:
  - `NETWORK_ERROR` (transient)
  - `RATE_LIMIT` (transient)
  - `INVALID_MEDIA` (permanent)
  - `REVOKED_TOKEN` (reconnect required)
  - `MISSING_PERMISSION` (permanent)
  - `UNKNOWN_ERROR` (catch-all)

---

## 13. Token Revocation Scope
* If Graph API returns a revoked User Access Token (Code 190), **all pages under the same FacebookAccount** are marked `isSynced = false`.
* On specific single Page API auth errors, **only that affected Page** is marked `isSynced = false`.

---

## 14. Complete API Route List & Authentication
All routes require a valid active and approved user session.
* **`GET /api/facebook/jobs`**: Lists user's jobs. Authenticated via `getSessionUser`.
* **`POST /api/facebook/jobs`**: Bulk creates scheduled jobs. Verified via `verifyAdminSession` (CSRF checked).
* **`GET /api/facebook/jobs/[id]`**: Retrieves owned job detail. Scoped by `getSessionUser`.
* **`POST /api/facebook/jobs/[id]/cancel`**: Aborts a pre-provider job. Verified via `verifyAdminSession`.
* **`POST /api/facebook/jobs/[id]/retry`**: Resets and schedules failed jobs. Verified via `verifyAdminSession`.
* **`POST /api/facebook/jobs/[id]/trigger`**: Instantly schedules a job. Verified via `verifyAdminSession`.
* **`POST /api/admin/worker`**: Webhook worker trigger. Gated with `verifyAdminRole` (disabled/blocked in production env).

---

## 15. Audit-Log Integration
Every transition executes inside a database transaction containing:
- Status transition validation
- Fencing checks
- Attempt/lifecycle updates
- Lease cleanup
- `AuditLog` creation: `Job [id] transitioned from [current] to [next] (Classification: [enum])`
- Related page/account sync state updates.

---

## 16. Dashboard Behavior
* SPA hook loads jobs via `GET /api/facebook/jobs` on mount.
* UI cancels and retries invoke respective endpoints.
* Logs and counters are refreshed from the server.

---

## 17. UTC Storage and Asia/Kolkata Display
* **Storage**: DB datetimes (`scheduledTimeUTC`, `startedAt`, `completedAt`, `failedAt`) are saved in UTC using timezone-aware Postgres columns.
* **Client**: Accept input and display times in `Asia/Kolkata` time zone, converting to UTC for DB operations.

---

## 18. E2E and Integration Test Checklist
Test database safety is mandatory. The test script must abort unless the database name is explicitly recognized as a test database, such as `fb_publisher_test`. It must never fall back to the current development or production database. No reset, truncate, drop, or bulk deletion may run against non-test data. Tests verify:
1. **Future Scheduled Jobs**: Verify future scheduled jobs are not claimed.
2. **Due Scheduled Jobs**: Verify due scheduled jobs are claimed.
3. **Attempt Limits**: Jobs with `attemptCount >= maxAttempts` cannot be claimed.
4. **Atomic Concurrent Claims**: Asserts lock prevents double execution.
5. **Ownership and Permissions check**: Scoping gates.
6. **Every Valid and Invalid Transition**: State rules.
7. **CANCELLED cannot restart**: Terminal checks.
8. **FAILED_PERMANENT cannot retry**: Terminal checks.
9. **FACEBOOK_RECONNECT_REQUIRED cannot retry before revalidation**.
10. **Successful Reconnect Transition**: Verifies re-queues.
11. **Suspended and Unapproved user rejection**: Blocks session.
12. **Legacy FAILED compatibility**: Reads but doesn't write.
13. **Mock Scenarios**: Verifies all 8 mock scenarios.
14. **Expired-Lock Recovery**: Checks PREPARING, UPLOADING_TO_META, PUBLISHING, and META_PROCESSING recovery.
15. **UPLOADING_TO_META and PUBLISHING crash recovery**: Asserts idempotency (no duplicate posts).
16. **META_PROCESSING resumption**: Claim resumes after due time.
17. **Fencing and lock checks**: Fails stale worker updates.
18. **Transaction rollback**: Asserts status updates roll back if audit log write fails.

---

## 19. Exact Verification Commands
* `git status`
* `git diff --check`
* `Get-Content prisma/migrations/20260713203000_add_publishing_job_state_fields/migration.sql` (or search migration SQL for DROP, TRUNCATE, DELETE and unsafe destructive ALTER statements)
* `npx.cmd prisma validate`
* `npx.cmd prisma generate`
* `npx.cmd tsc --noEmit --pretty false`
* `npx.cmd eslint .`
* `npx.cmd tsx scripts/run-phase3-tests.ts`
* `npm.cmd run build`
* `npx.cmd prisma migrate status`
* Read-only pre-deployment ownership/retryCount verification check
* Read-only post-deployment schema verification check

---

## 20. Risks and Limitations
* **Simulated Polling**: Mock resumptions require multiple runs of the worker script.
* **Cascade token invalidation**: Token revocation flags all pages under the connected profile as de-synced.
