# Test Plan: Facebook Multi-Page Publisher

This document describes the testing strategy, test suites, and step-by-step verification methods for validation of the Facebook Multi-Page Publisher application.

---

## 1. Testing Strategy

The application verification is split into three main layers:

```
+-----------------------------------------------------------------+
|                       E2E Testing (Manual)                      |
|  - Real Facebook Sandbox Pages, Live uploads, scheduling flows |
+-----------------------------------------------------------------+
                               |
                               v
+-----------------------------------------------------------------+
|                  Integration Testing (Automated)                 |
|  - Mock Meta Graph API responses, mock GCS Uploads, Prisma DB    |
+-----------------------------------------------------------------+
                               |
                               v
+-----------------------------------------------------------------+
|                     Unit Testing (Automated)                    |
|  - Token Encryption, Input validations (English), Date Math     |
+-----------------------------------------------------------------+
```

---

## 2. Test Suites and Scenarios

### 2.1. Cryptography and Token Security (Unit Tests)
- **Encryption Integrity**: Ensure plaintext tokens passed to the encryption utility do not match the output ciphertext.
- **Decryption Accuracy**: Verify that decrypting the ciphertext returns the exact original plaintext token.
- **IV Uniqueness**: Verify that encrypting the same token twice yields different ciphertexts due to different Initialization Vectors.
- **Tampering Detection**: Verify that changing even a single byte of the encrypted string or the auth tag triggers an decryption error (verification failure).

### 2.2. Data Validation (Unit Tests)
- **English-Only Captions**: Check that strings with standard English letters, numbers, punctuation, and emojis pass validation.
- **Non-English Rejection**: Check that strings containing Cyrillic, Chinese, Arabic, or other non-English blocks are flagged as invalid.
- **Hashtag Verification**: Verify that hashtags match the required regex formats and do not contain special characters.
- **Title Limits**: Assert that titles exceeding 255 characters are rejected before database save.

### 2.3. Facebook Login & Page Sync (Integration Tests)
- **Mock Token Exchange**: Mock the Meta OAuth exchange endpoint to return dummy access tokens, verifying that the application processes and saves them safely.
- **Mock Page Sync**: Mock the GET `/me/accounts` endpoint to return a fixed list of three mock Facebook Pages. Verify that:
  - All three pages are populated in PostgreSQL.
  - Page Access Tokens are encrypted upon insert.
  - De-synced pages are deleted or flagged as `isSynced = false`.

### 2.4. Job Scheduling & Interval Mathematics (Unit & Integration Tests)
- **UTC Time Calculations**: Verify that date strings input in `Asia/Kolkata` timezone convert to the exact corresponding UTC timestamp in the database.
- **Interval Spacing Calculations**: Input 4 jobs and specify a 2-hour interval. Verify that the scheduled times correspond to:
  - Job 1: `StartTime`
  - Job 2: `StartTime + 2 Hours`
  - Job 3: `StartTime + 4 Hours`
  - Job 4: `StartTime + 6 Hours`
- **Cloud Task Payload Validation**: Mock the Cloud Tasks SDK. Validate that the task payload matches the database ID and target endpoint, and the execution date matches `scheduledTimeUTC`.

### 2.5. Video Publishing & Error Handling (Worker Integration Tests)
- **Mock Chunked Upload Flow**: Mock the Meta Video/Reels API chunked endpoints (`/videos` or `/video_reels`). Simulate:
  - Phase 1 (Init): Mock returning video upload session IDs.
  - Phase 2 (Upload): Mock returning chunk status.
  - Phase 3 (Finish): Mock returning the publish ID (`123456789`).
  - Verify that the database state updates to `PUBLISHED` with `metaPostId = '123456789'`.
- **Transient Failure and Retry**: Mock a Meta API timeout. Verify that the queue system schedules a retry and increments `retryCount` up to 3.
- **Fatal Token Expiration**: Mock Meta API returning error code `190` (expired token). Verify that the database updates the job status to `FAILED`, saves the error log details, and updates the relevant page's token status.

---

## 3. Manual E2E Verification Checklists

These verification tasks must be performed manually using Meta Developer Sandbox accounts prior to production launch:

| Step | Action | Expected Outcome |
| :--- | :--- | :--- |
| 1 | Register Meta Test User & Test Page | Valid sandbox credentials and test page are ready in the Meta developer portal. |
| 2 | Authenticate via Web App dashboard | Redirects to Facebook, displays permissions dialog, returns to web app. Page lists synchronizes immediately. |
| 3 | Bulk Upload 3 Videos & Thumbnails | GCS Upload progress bars render smoothly. Metadata forms populate for all 3 assets. |
| 4 | Assign Scheduled Times | Define a future publish time in `Asia/Kolkata` timezone. Confirm scheduling. |
| 5 | Verify DB Records | DB records show UTC time conversions. Cloud Tasks queue shows pending tasks. |
| 6 | Await Scheduled Trigger | At the target time, the background worker triggers. Check Graph API posts. |
| 7 | Confirm Facebook Live Post | The video is live on the Meta Page with correct English title, caption, hashtags, and custom thumbnail. |
| 8 | Validate Log Masking | Inspect console logs and telemetry. Verify no occurrences of Facebook access tokens are present. |
