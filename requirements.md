# Requirements Specification: Facebook Multi-Page Publisher

This document outlines the detailed functional, non-functional, and compliance requirements for the Facebook Multi-Page Publisher application.

---

## 1. Project Overview

The Facebook Multi-Page Publisher is a web application designed for a single administrator to manage and schedule video uploads across multiple Facebook Pages. The administrator connects their Facebook account via official OAuth channels, synchronizes the pages they manage, bulk-uploads video and thumbnail assets, adds English titles, captions, and hashtags, schedules post times (individually or in batch intervals), and relies on a cloud worker to publish the content automatically in the background.

---

## 2. Strict Compliance and Safety Rules

To ensure long-term stability and compliance with Meta's developer policies, the application must adhere to the following safety constraints:

1. **Official APIs Only**: Use exclusively the official Meta Facebook Login, Graph API, Pages API, Video API, and Reels Publishing API.
2. **No Automation Workarounds**: Do not use Playwright, Selenium, browser auto-clicking, HTML scraping, private/undocumented APIs, or saved browser cookies.
3. **No Password Storage**: Never ask for, collect, or store the administrator's Facebook password.
4. **Cloud-Based Operations**: The administrator's local machine must not need to remain turned on after scheduling videos. All scheduling, uploads, and publishing operations must execute via cloud tasks and background workers.
5. **Timezone Handling**:
   - Store all publishing times in UTC in the database.
   - Display and accept all publishing times in the `Asia/Kolkata` timezone in the UI.
6. **Video Language**: All user-entered text (titles, captions, hashtags) and video-related language controls must be restricted to English.
7. **Documented Fields Only**: Do not send undocumented Meta API fields or parameters.
8. **Token Encryption & Privacy**: Facebook user and page access tokens must be strongly encrypted at rest and must never be exposed to the client-side browser, screenshots, or server logs.

---

## 3. Detailed Functional Requirements

### 3.1. Complete User Workflow
1. **User Authentication**: The single administrator logs into the web application using a local secure dashboard login.
2. **Meta Account Connection**: The admin clicks "Connect Facebook Account", initiating the official Meta Facebook Login OAuth flow.
3. **Page Synchronization**: After login, the system calls the Meta Graph API to fetch all Facebook Pages managed by the admin.
4. **Bulk Video Upload**: The admin bulk-uploads video files and thumbnail images.
5. **Metadata Assignment**: For each video, the admin assigns:
   - English Title
   - English Caption (including Hashtags)
   - Custom Thumbnail or Default thumbnail
   - Target Facebook Page (from the list of synced pages)
   - Scheduled Date and Time (in `Asia/Kolkata` timezone)
6. **Bulk Interval Scheduling (Optional)**: Instead of setting individual times manually, the admin can input a start time and a fixed interval (e.g., "every 2 hours") to automatically space out the selected videos.
7. **Schedule Confirmation**: The admin clicks "Schedule Publishing". The videos are queued, and Cloud Tasks are created.
8. **Asynchronous Publishing**: The cloud worker fires at each scheduled time, retrieves the encrypted page access token, uploads the video metadata to Facebook's API, and updates the dashboard status.

---

### 3.2. Managed Facebook Page Synchronization
- **API Flow**: The app requests the `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts` permissions during Facebook Login.
- **Sync Process**:
  - Request user pages via Graph API GET `/me/accounts`.
  - Retrieve the Page Name, Page ID, Category, Picture, and the Page Access Token.
  - Store Page Access Tokens securely (encrypted) in the database.
  - Expose only the Page Name, ID, Category, and Picture to the client UI.
- **Automatic Sync updates**: Allow the administrator to trigger a manual "Re-sync Pages" command in the dashboard.

---

### 3.3. Bulk Video Upload Workflow
- **Upload Mechanism**: Direct-to-GCS upload via signed URLs. This bypasses the Next.js server, preventing timeout and bandwidth bottlenecks.
- **Progress Tracking**: The frontend displays individual upload progress bars for each video file and thumbnail.
- **State Handling**: Uploads are executed asynchronously. Once a file finishes uploading, the UI updates to show the metadata edit form for that specific video.

---

### 3.4. English Titles, Captions, and Hashtags
- **Validation**: Strict client-side and server-side validation to ensure metadata is in English.
- **Content Limits**:
  - **Titles**: Maximum 255 characters (Facebook constraint).
  - **Captions**: Standard character boundaries enforced.
  - **Hashtags**: Standard regex extraction to validate and append hashtags appropriately.
- **Language Enforcement**: Prevent submissions containing non-English character blocks or symbols not standard to the English character set.

---

### 3.5. Individual Thumbnail Selection
- **Default Option**: Use the default thumbnail auto-generated by Facebook during processing.
- **Custom Option**: Admin uploads a custom image file (JPEG/PNG) to Google Cloud Storage.
- **Association**: The database record links the GCS thumbnail URI to the specific video job. During publish time, the custom thumbnail is passed to Meta's API.

---

### 3.6. Individual Publishing Time
- **Input**: Date/time selector in the UI. Timepicker defaults to `Asia/Kolkata` timezone.
- **Storage**: Convert user's selected `Asia/Kolkata` time to UTC before writing to the database.
- **Display**: Convert UTC database records back to `Asia/Kolkata` timezone when rendering the dashboard.

---

### 3.7. Fixed Interval Scheduling
- **Bulk Scheduling Interface**: A configuration panel allowing:
   - Start Time (e.g., Today at 10:00 AM Asia/Kolkata).
   - Interval Spacing (e.g., 2 hours, 4 hours, 1 day).
- **Execution**: Clicking "Apply Interval" programmatically calculates and assigns the `scheduled_publish_time` for each video in the bulk batch (e.g., Video 1 at 10:00 AM, Video 2 at 12:00 PM, Video 3 at 2:00 PM).

---

### 3.8. Multiple Page Support
- **Page Selection**: The admin can assign a different target page to each video in the list.
- **Account Aggregation**: All synced pages across connected accounts are displayed as scheduling destinations.

---

### 3.9. Publishing Status Tracking
The system must support the following job states:
- `DRAFT`: Local metadata entered, files uploaded, but not yet scheduled.
- `SCHEDULED`: Cloud Task created; awaiting execution.
- `PUBLISHING`: Cloud Task has triggered; worker is active and uploading to Facebook.
- `PUBLISHED`: Successfully posted to Facebook (stores Meta's return Post ID or Reel ID).
- `FAILED`: Meta API rejected the video, upload timed out, or connection failed. Includes an error log in the database.

---

### 3.10. Retry and Error Handling
- **Transient Failures**: If the Meta API returns a retriable error (e.g., HTTP 500, network timeout, rate limit exceeded), the Cloud Task will retry with exponential backoff.
- **Max Retries**: Limit automatic retries to 3 attempts.
- **Fatal Failures**: If the error is fatal (e.g., Token expired, video file corrupted, invalid permissions), immediately mark the status as `FAILED` and log the reason.
- **Admin Alerting**: Highlight failed jobs on the dashboard with diagnostic messages.

---

### 3.11. Facebook Token Expiration and Reconnection
- **Token Type**: User Access Token is exchanged for a Long-Lived User Access Token (valid for 60 days). Page Access Tokens obtained from a long-lived user token are typically permanent unless the admin changes passwords or revokes app access.
- **Monitoring**: The worker evaluates Graph API responses. If an API call fails with error code `190` (Invalid/expired token), the app marks the respective pages as disconnected.
- **Reconnection Flow**: The dashboard prominently displays a warning banner ("Facebook Account Reconnection Required") if any token expires, directing the user to click "Reconnect" to refresh the OAuth tokens.
