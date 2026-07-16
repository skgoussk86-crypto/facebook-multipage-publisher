import "server-only";
import { Readable } from "stream";

export interface GoogleDriveResumableUploadInput {
  readonly accessToken: string;
  readonly folderId: string;
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly totalBytes: number;
}

export interface GoogleDriveResumableUploadSession {
  readonly sessionUri: string;
}

export interface GoogleDriveFileMetadata {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly md5Checksum: string | null;
  readonly modifiedTime: Date | null;
  readonly parents: readonly string[];
  readonly trashed: boolean;
  readonly appProperties: Readonly<Record<string, string>>;
}

export interface GoogleDriveMediaClientOptions {
  readonly fetchImpl?: typeof fetch;
}

export class GoogleDriveFileNotFoundError extends Error {
  constructor(fileId: string) {
    super(`Google Drive file not found: ${fileId}`);
    this.name = "GoogleDriveFileNotFoundError";
    Object.setPrototypeOf(this, GoogleDriveFileNotFoundError.prototype);
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

// Input validation helpers
function validateAccessToken(accessToken: string): void {
  if (!accessToken || accessToken.trim() === "") {
    throw new Error("Access token is required.");
  }
}

function validateResumableUploadInput(input: GoogleDriveResumableUploadInput): void {
  validateAccessToken(input.accessToken);
  if (!input.folderId || input.folderId.trim() === "") {
    throw new Error("Folder ID is required.");
  }
  if (!input.assetId || input.assetId.trim() === "") {
    throw new Error("Asset ID is required.");
  }
  if (!input.fileName || input.fileName.trim() === "") {
    throw new Error("File name is required.");
  }
  const trimmedFileName = input.fileName.trim();
  if (trimmedFileName.length > 255) {
    throw new Error("File name exceeds 255 characters.");
  }
  if (/[\x00-\x1F\x7F]/.test(trimmedFileName)) {
    throw new Error("File name contains control characters.");
  }
  if (!input.mimeType || input.mimeType.trim() === "") {
    throw new Error("MIME type is required.");
  }
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes <= 0) {
    throw new Error("Total bytes must be a positive safe integer.");
  }
}

function validateFileId(fileId: string): void {
  if (!fileId || fileId.trim() === "") {
    throw new Error("File ID is required.");
  }
  const trimmed = fileId.trim();
  if (/[\x00-\x1F\x7F/\\?#]/.test(trimmed)) {
    throw new Error("File ID contains invalid characters.");
  }
}

export async function initiateGoogleDriveResumableUpload(
  input: GoogleDriveResumableUploadInput,
  options?: GoogleDriveMediaClientOptions
): Promise<GoogleDriveResumableUploadSession> {
  validateResumableUploadInput(input);

  const activeFetch = options?.fetchImpl || fetch;
  const url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id%2Cname%2CmimeType%2Csize%2Cmd5Checksum%2CmodifiedTime%2Cparents%2Ctrashed";

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${input.accessToken.trim()}`,
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": input.mimeType.trim(),
    "X-Upload-Content-Length": input.totalBytes.toString(),
  };

  const body = JSON.stringify({
    name: input.fileName.trim(),
    parents: [input.folderId.trim()],
    appProperties: {
      fbPublisherPurpose: "mediaAsset",
      fbPublisherAssetId: input.assetId.trim(),
    },
  });

  let response: Response;
  try {
    response = await activeFetch(url, {
      method: "POST",
      headers,
      body,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Google Drive request failed: ${msg}`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Google Drive resumable upload initiation failed. Status: ${response.status}`);
  }

  const sessionUri = response.headers.get("location");
  if (!sessionUri || sessionUri.trim() === "") {
    throw new Error("Google Drive resumable upload initiation failed: Location header is missing or empty.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sessionUri);
  } catch {
    throw new Error("Invalid resumable session URI: Not a valid absolute URL.");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error("Invalid resumable session URI: Protocol must be HTTPS.");
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new Error("Invalid resumable session URI: Credentials must be absent.");
  }
  if (parsedUrl.hash !== "") {
    throw new Error("Invalid resumable session URI: Fragment must be absent.");
  }
  const hostname = parsedUrl.hostname;
  if (hostname !== "www.googleapis.com" && !hostname.endsWith(".googleapis.com")) {
    throw new Error("Invalid resumable session URI: Hostname must end with .googleapis.com.");
  }

  return {
    sessionUri,
  };
}

export async function getGoogleDriveFileMetadata(
  accessToken: string,
  fileId: string,
  options?: GoogleDriveMediaClientOptions
): Promise<GoogleDriveFileMetadata | null> {
  validateAccessToken(accessToken);
  validateFileId(fileId);

  const activeFetch = options?.fetchImpl || fetch;
  const encodedId = encodeURIComponent(fileId.trim());
  const url = `https://www.googleapis.com/drive/v3/files/${encodedId}?fields=id%2Cname%2CmimeType%2Csize%2Cmd5Checksum%2CmodifiedTime%2Cparents%2Ctrashed%2CappProperties`;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken.trim()}`,
  };

  let response: Response;
  try {
    response = await activeFetch(url, {
      method: "GET",
      headers,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Google Drive request failed: ${msg}`);
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Google Drive file metadata retrieval failed. Status: ${response.status}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse response JSON: ${msg}`);
  }

  if (!isRecord(data)) {
    throw new Error("Google Drive file metadata response is invalid.");
  }

  const id = data.id;
  const name = data.name;
  const mimeType = data.mimeType;

  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("Google Drive file metadata is missing required field: id.");
  }
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("Google Drive file metadata is missing required field: name.");
  }
  if (typeof mimeType !== "string" || mimeType.trim() === "") {
    throw new Error("Google Drive file metadata is missing required field: mimeType.");
  }

  const parsedSize = Number(data.size);
  if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) {
    throw new Error("Google Drive file metadata has invalid size.");
  }

  const md5Checksum = typeof data.md5Checksum === "string" && data.md5Checksum.trim() !== "" ? data.md5Checksum : null;

  let modifiedTime: Date | null = null;
  if (typeof data.modifiedTime === "string" && data.modifiedTime.trim() !== "") {
    const d = new Date(data.modifiedTime);
    if (!isNaN(d.getTime())) {
      modifiedTime = d;
    }
  }

  let parents: readonly string[] = [];
  if (Array.isArray(data.parents)) {
    parents = Object.freeze(data.parents.filter((p: unknown) => typeof p === "string" && p.trim() !== "") as string[]);
  }

  const trashed = typeof data.trashed === "boolean" ? data.trashed : false;

  const parsedAppProps: Record<string, string> = {};
  const rawAppProps = data.appProperties;
  if (isRecord(rawAppProps)) {
    for (const [key, val] of Object.entries(rawAppProps)) {
      if (typeof val === "string") {
        parsedAppProps[key] = val;
      }
    }
  }
  const appProperties = Object.freeze(parsedAppProps);

  return {
    id: id.trim(),
    name: name.trim(),
    mimeType: mimeType.trim(),
    size: parsedSize,
    md5Checksum,
    modifiedTime,
    parents,
    trashed,
    appProperties,
  };
}

export async function createGoogleDriveFileReadStream(
  accessToken: string,
  fileId: string,
  options?: GoogleDriveMediaClientOptions
): Promise<Readable> {
  validateAccessToken(accessToken);
  validateFileId(fileId);

  const activeFetch = options?.fetchImpl || fetch;
  const encodedId = encodeURIComponent(fileId.trim());
  const url = `https://www.googleapis.com/drive/v3/files/${encodedId}?alt=media`;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken.trim()}`,
  };

  let response: Response;
  try {
    response = await activeFetch(url, {
      method: "GET",
      headers,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Google Drive request failed: ${msg}`);
  }

  if (response.status === 404) {
    throw new GoogleDriveFileNotFoundError(fileId);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Google Drive file download failed. Status: ${response.status}`);
  }

  const stream = response.body;
  if (!stream) {
    throw new Error("Google Drive download response body is missing.");
  }

  const nodeReadable = Readable.fromWeb(stream as import("stream/web").ReadableStream<Uint8Array>);
  return nodeReadable;
}

export async function deleteGoogleDriveFile(
  accessToken: string,
  fileId: string,
  options?: GoogleDriveMediaClientOptions
): Promise<boolean> {
  validateAccessToken(accessToken);
  validateFileId(fileId);

  const activeFetch = options?.fetchImpl || fetch;
  const encodedId = encodeURIComponent(fileId.trim());
  const url = `https://www.googleapis.com/drive/v3/files/${encodedId}`;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken.trim()}`,
  };

  let response: Response;
  try {
    response = await activeFetch(url, {
      method: "DELETE",
      headers,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Google Drive request failed: ${msg}`);
  }

  if (response.status === 404) {
    return false;
  }

  if (response.status >= 200 && response.status < 300) {
    return true;
  }

  throw new Error(`Google Drive file deletion failed. Status: ${response.status}`);
}
