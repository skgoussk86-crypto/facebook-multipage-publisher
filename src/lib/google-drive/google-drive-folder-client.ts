import "server-only";

export interface GoogleDriveMediaFolder {
  readonly id: string;
  readonly name: string;
}

export interface GoogleDriveFolderClientOptions {
  readonly fetchImpl?: typeof fetch;
}

const MIME_FOLDER = "application/vnd.google-apps.folder";
const APP_PROP_KEY = "fbPublisherPurpose";
const APP_PROP_VAL = "mediaRoot";

export async function findGoogleDriveMediaFolder(
  accessToken: string,
  options?: GoogleDriveFolderClientOptions
): Promise<GoogleDriveMediaFolder | null> {
  if (!accessToken || accessToken.trim() === "") {
    throw new Error("Access token is required.");
  }

  const fetchFn = options?.fetchImpl || fetch;

  const q = `mimeType = '${MIME_FOLDER}' and trashed = false and appProperties has { key='${APP_PROP_KEY}' and value='${APP_PROP_VAL}' }`;
  const params = new URLSearchParams({
    q,
    spaces: "drive",
    corpora: "user",
    pageSize: "100",
    fields: "files(id,name,appProperties),nextPageToken",
  });

  const response = await fetchFn(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Google Drive folder lookup failed with status ${response.status}.`);
  }

  const data = await response.json();
  if (data && Array.isArray(data.files)) {
    for (const file of data.files) {
      if (
        file &&
        typeof file.id === "string" &&
        file.id.trim() !== "" &&
        typeof file.name === "string" &&
        file.name.trim() !== ""
      ) {
        return {
          id: file.id,
          name: file.name,
        };
      }
    }
  }

  return null;
}

export async function createGoogleDriveMediaFolder(
  accessToken: string,
  folderName?: string,
  options?: GoogleDriveFolderClientOptions
): Promise<GoogleDriveMediaFolder> {
  if (!accessToken || accessToken.trim() === "") {
    throw new Error("Access token is required.");
  }

  let trimmedFolderName = "";
  if (folderName !== undefined) {
    if (folderName.trim() === "") {
      throw new Error("Google Drive folder name is required.");
    }
    trimmedFolderName = folderName.trim();
  } else {
    const envVal = process.env.GOOGLE_DRIVE_FOLDER_NAME;
    if (envVal && envVal.trim() !== "") {
      trimmedFolderName = envVal.trim();
    } else {
      trimmedFolderName = "Facebook Multi-Page Publisher";
    }
  }

  const fetchFn = options?.fetchImpl || fetch;

  const metadata = {
    name: trimmedFolderName,
    mimeType: MIME_FOLDER,
    appProperties: {
      [APP_PROP_KEY]: APP_PROP_VAL,
    },
  };

  const response = await fetchFn("https://www.googleapis.com/drive/v3/files?fields=id,name,appProperties", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    throw new Error(`Google Drive folder creation failed with status ${response.status}.`);
  }

  const data = await response.json();
  if (
    !data ||
    typeof data.id !== "string" ||
    data.id.trim() === "" ||
    typeof data.name !== "string" ||
    data.name.trim() === ""
  ) {
    throw new Error("Google Drive API response did not contain a valid folder ID or name.");
  }

  return {
    id: data.id,
    name: data.name,
  };
}

export async function findOrCreateGoogleDriveMediaFolder(
  accessToken: string,
  folderName?: string,
  options?: GoogleDriveFolderClientOptions
): Promise<GoogleDriveMediaFolder> {
  const existing = await findGoogleDriveMediaFolder(accessToken, options);
  if (existing) {
    return existing;
  }
  return await createGoogleDriveMediaFolder(accessToken, folderName, options);
}
