import "server-only";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const APP_PROPERTY_KEY = "fbPublisherPurpose";
const APP_PROPERTY_VALUE = "mediaRoot";

/**
 * Sanitizes response streams and returns a clean, safe Error instance without exposing credentials.
 */
async function handleDriveApiError(response: Response, defaultMessage: string): Promise<never> {
  const status = response.status;
  let errMsg = defaultMessage;
  try {
    const data = await response.json();
    if (data && data.error && typeof data.error.message === "string") {
      errMsg = data.error.message;
    }
  } catch {
    // Non-JSON response, ignore parsing and default to standard fallback message
  }
  throw new Error(`Google Drive API error (status ${status}): ${errMsg}`);
}

/**
 * Searches for a folder matching the specific appProperties key-value tag.
 */
export async function findGoogleDriveMediaFolder(
  accessToken: string
): Promise<{ id: string; name: string } | null> {
  if (!accessToken || accessToken.trim() === "") {
    throw new Error("Access token is required.");
  }

  const q = `mimeType = '${FOLDER_MIME_TYPE}' and trashed = false and appProperties has { key='${APP_PROPERTY_KEY}' and value='${APP_PROPERTY_VALUE}' }`;
  const params = new URLSearchParams({
    q,
    spaces: "drive",
    corpora: "user",
    pageSize: "100",
    fields: "files(id,name,appProperties),nextPageToken",
  });

  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    await handleDriveApiError(response, "Failed to locate media folder.");
  }

  const data = await response.json();
  if (data && Array.isArray(data.files)) {
    for (const file of data.files) {
      if (file && typeof file.id === "string" && typeof file.name === "string") {
        return {
          id: file.id,
          name: file.name,
        };
      }
    }
  }

  return null;
}

/**
 * Creates a brand new, private Google Drive folder marked with application properties tags.
 */
export async function createGoogleDriveMediaFolder(
  accessToken: string
): Promise<{ id: string; name: string }> {
  if (!accessToken || accessToken.trim() === "") {
    throw new Error("Access token is required.");
  }

  const folderName = process.env.GOOGLE_DRIVE_FOLDER_NAME || "Facebook Multi-Page Publisher";
  if (!folderName || folderName.trim() === "") {
    throw new Error("GOOGLE_DRIVE_FOLDER_NAME configuration value is missing or empty.");
  }

  const metadata = {
    name: folderName.trim(),
    mimeType: FOLDER_MIME_TYPE,
    appProperties: {
      [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE,
    },
  };

  const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,appProperties", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    await handleDriveApiError(response, "Failed to create media folder.");
  }

  const data = await response.json();
  if (!data || typeof data.id !== "string" || typeof data.name !== "string") {
    throw new Error("Google Drive API response did not contain a valid folder ID or name.");
  }

  return {
    id: data.id,
    name: data.name,
  };
}

/**
 * Finds the media folder, or creates one if it doesn't already exist.
 */
export async function findOrCreateGoogleDriveMediaFolder(
  accessToken: string
): Promise<{ id: string; name: string }> {
  const existing = await findGoogleDriveMediaFolder(accessToken);
  if (existing) {
    return existing;
  }
  return await createGoogleDriveMediaFolder(accessToken);
}
