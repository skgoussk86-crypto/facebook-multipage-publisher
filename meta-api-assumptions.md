# Meta API Assumptions & Capabilities

This document details the features, assumptions, limits, and prerequisites of Meta's Graph API, Pages API, Video API, and Reels Publishing API.

---

## 1. Features Confirmed through Official Meta APIs

The following application capabilities are officially supported by Meta's public APIs and are confirmed for development:

- **OAuth 2.0 Authorization**: Facebook Login provides access tokens via the authorization code flow.
- **Managed Pages Retrieval**: Fetching a list of managed pages, including Page IDs, names, and Page Access Tokens, via GET `/v20.0/me/accounts` with the `pages_show_list` and `pages_read_engagement` permissions.
- **Long-Lived Tokens**: Exchanging short-lived User Access Tokens (2 hours) for Long-Lived User Access Tokens (60 days) via GET `/v20.0/oauth/access_token`. Page access tokens fetched with a long-lived user token are permanent by default, but subject to revocation on security events (e.g., user password changes).
- **Chunked Video Upload**: Meta's Video API supports a three-step resumable upload protocol (Create Upload Session, Upload Chunks, Finish Session) which handles video uploads up to 10GB.
- **Standard Video Scheduling**: The standard `/page_id/videos` endpoint supports setting scheduling parameters natively (e.g., `scheduled_publish_time`), but Meta caps this at 75 days in advance. To avoid limitations and allow updates/cancellations, the application uses external Cloud Tasks scheduling.
- **Custom Video Thumbnail**: Passing custom images for video thumbnails via the `thumb` parameter in standard video publishing calls is supported.

---

## 2. Features Requiring Live Meta App Testing

Due to Meta's strict application review sandboxes, some behaviors cannot be fully validated until a Live Meta App is registered and approved:

- **App Review and Permissions Approvals**: To request permissions such as `pages_manage_posts` and `pages_read_engagement` for public users (not just App Administrators/Developers/Testers), the App must go through the Meta App Review process.
- **Business Verification**: Apps requesting posting permissions typically must complete Business Verification under the Meta Business Suite before transitioning to "Live" mode.
- **Rate Limit Thresholds**: Graph API rate limits are applied dynamically based on app usage levels. Real-world testing is required to verify retry triggers when publishing batches of high-resolution video files.
- **Reconection UX**: The real-world invalidation flow when an admin updates their Facebook password requires live testing to verify that API calls consistently return HTTP 400 with subcode `463` or `467`.

---

## 3. Features That May Not Be Supported for Facebook Reels

The Reels Publishing API is distinct from the general Video Publishing API. The following constraints apply specifically to Reels:

- **No Custom Thumbnails via API**: Unlike standard video uploads, the current public Reels API (e.g., `/page_id/video_reels`) does not consistently allow uploading custom thumbnail images. It selects a frame automatically. *Validation on live pages is required.*
- **Aspect Ratio & Frame Limits**: Reels must conform to vertical aspect ratios (typically 9:16) and are strictly limited in duration (currently up to 90 seconds). Videos not meeting these metrics will be rejected by the Reels API.
- **No Native API Scheduling**: The `/video_reels` publishing endpoint does not consistently support native scheduling parameters. Using our Google Cloud Tasks system is the recommended way to schedule Reels by delaying the final publish API request.
- **Description Constraints**: Reels use a single caption field (represented as `description` or `caption`). The standard `title` field used for long-form video uploads is ignored or merged into the caption depending on the platform layout.

---

## 4. Features That Must Never Be Implemented with Browser Automation

To protect the app administrator's account from being disabled for compliance violations, the following functions **must never** be implemented using Selenium, Playwright, cookies scraping, or headless browsers:

- **Facebook Account Login**: Automating the authentication forms or parsing HTML forms. The standard Meta Facebook Login popup / redirect flow is the only permitted method.
- **Video Publishing Auto-Clicking**: Bypassing the Video/Reels API by scripting actions inside the Meta Business Suite dashboard.
- **Bypassing App Review**: Attempting to publish posts via automated browser scripts to avoid completing the official Meta App Review and Business Verification process.
- **Session Cookie Harvesting**: Scraping cookies from the administrator's browser session or asking the user to paste session cookies into the dashboard.
