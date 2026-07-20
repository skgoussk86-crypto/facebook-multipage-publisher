import "server-only";
import { randomUUID } from "node:crypto";

export type GoogleDriveThumbnailSource =
  | "GEMINI_FRAME"
  | "MANUAL_FRAME"
  | "CUSTOM_UPLOAD";

export interface GoogleDriveThumbnailUploadInput {
  readonly accessToken: string;
  readonly folderId: string;
  readonly sourceVideoAssetId: string;
  readonly fileName: string;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly bytes: Buffer;
  readonly source: GoogleDriveThumbnailSource;
  readonly timestampMs?: number | null;
}

export interface GoogleDriveThumbnailFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly md5Checksum: string | null;
  readonly parents: readonly string[];
  readonly trashed: boolean;
  readonly appProperties: Readonly<Record<string, string>>;
}

export interface GoogleDriveThumbnailClientOptions {
  readonly fetchImpl?: typeof fetch;
}

function requireNonEmpty(
  value: string,
  name: string,
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }

  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error(`${name} contains control characters.`);
  }

  return trimmed;
}

function validateInput(
  input: GoogleDriveThumbnailUploadInput,
): void {
  requireNonEmpty(input.accessToken, "Access token");
  requireNonEmpty(input.folderId, "Folder ID");
  requireNonEmpty(
    input.sourceVideoAssetId,
    "Source video asset ID",
  );

  const fileName =
    requireNonEmpty(input.fileName, "File name");

  if (fileName.length > 255) {
    throw new Error(
      "Thumbnail file name exceeds 255 characters.",
    );
  }

  if (/[\\/]/.test(fileName)) {
    throw new Error(
      "Thumbnail file name must not contain path separators.",
    );
  }

  if (
    input.mimeType !== "image/jpeg" &&
    input.mimeType !== "image/png"
  ) {
    throw new Error(
      "Thumbnail MIME type must be image/jpeg or image/png.",
    );
  }

  if (
    !Buffer.isBuffer(input.bytes) ||
    input.bytes.length <= 0
  ) {
    throw new Error(
      "Thumbnail bytes must be a nonempty Buffer.",
    );
  }

  if (
    input.timestampMs !== undefined &&
    input.timestampMs !== null &&
    (
      !Number.isSafeInteger(input.timestampMs) ||
      input.timestampMs < 0
    )
  ) {
    throw new Error(
      "Thumbnail timestamp must be a nonnegative safe integer.",
    );
  }
}

function parseStringRecord(
  value: unknown,
): Readonly<Record<string, string>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }

  return result;
}

export async function uploadGoogleDriveThumbnail(
  input: GoogleDriveThumbnailUploadInput,
  options?: GoogleDriveThumbnailClientOptions,
): Promise<GoogleDriveThumbnailFile> {
  validateInput(input);

  const activeFetch =
    options?.fetchImpl || fetch;

  const boundary =
    `fbPublisherThumbnail${randomUUID().replace(/-/g, "")}`;

  const appProperties: Record<string, string> = {
    fbPublisherPurpose: "thumbnailAsset",
    fbPublisherSourceVideoAssetId:
      input.sourceVideoAssetId.trim(),
    fbPublisherThumbnailSource: input.source,
  };

  if (
    input.timestampMs !== undefined &&
    input.timestampMs !== null
  ) {
    appProperties.fbPublisherThumbnailTimestampMs =
      input.timestampMs.toString();
  }

  const metadata = {
    name: input.fileName.trim(),
    parents: [input.folderId.trim()],
    appProperties,
  };

  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${input.mimeType}\r\n\r\n`,
    "utf8",
  );

  const suffix = Buffer.from(
    `\r\n--${boundary}--\r\n`,
    "utf8",
  );

  const requestBody = Buffer.concat([
    prefix,
    input.bytes,
    suffix,
  ]);

  const url =
    "https://www.googleapis.com/upload/drive/v3/files" +
    "?uploadType=multipart" +
    "&fields=id%2Cname%2CmimeType%2Csize%2Cmd5Checksum%2Cparents%2Ctrashed%2CappProperties";

  let response: Response;

  try {
    response = await activeFetch(url, {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${input.accessToken.trim()}`,
        "Content-Type":
          `multipart/related; boundary=${boundary}`,
        "Content-Length":
          requestBody.length.toString(),
      },
      body:
        requestBody as unknown as BodyInit,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    throw new Error(
      `Google Drive thumbnail upload request failed: ${message}`,
    );
  }

  const responseText =
    await response.text();

  let parsed: unknown = {};

  if (responseText) {
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = {
        raw: responseText.slice(0, 500),
      };
    }
  }

  if (!response.ok) {
    throw new Error(
      `Google Drive thumbnail upload failed. Status: ${response.status}.`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "Google Drive thumbnail upload returned an invalid response.",
    );
  }

  const body =
    parsed as Record<string, unknown>;

  const id =
    typeof body.id === "string"
      ? body.id.trim()
      : "";

  if (!id) {
    throw new Error(
      "Google Drive thumbnail upload response is missing the file ID.",
    );
  }

  const name =
    typeof body.name === "string" &&
    body.name.trim()
      ? body.name.trim()
      : input.fileName.trim();

  const mimeType =
    typeof body.mimeType === "string" &&
    body.mimeType.trim()
      ? body.mimeType.trim()
      : input.mimeType;

  const parsedSize =
    typeof body.size === "string" ||
    typeof body.size === "number"
      ? Number(body.size)
      : input.bytes.length;

  const size =
    Number.isSafeInteger(parsedSize) &&
    parsedSize >= 0
      ? parsedSize
      : input.bytes.length;

  const parents =
    Array.isArray(body.parents)
      ? body.parents.filter(
          (entry): entry is string =>
            typeof entry === "string",
        )
      : [input.folderId.trim()];

  const trashed =
    body.trashed === true;

  if (trashed) {
    throw new Error(
      "Google Drive returned a trashed thumbnail file.",
    );
  }

  return {
    id,
    name,
    mimeType,
    size,
    md5Checksum:
      typeof body.md5Checksum === "string"
        ? body.md5Checksum
        : null,
    parents,
    trashed,
    appProperties:
      parseStringRecord(body.appProperties),
  };
}
