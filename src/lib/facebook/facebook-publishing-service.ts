import { MockScenario } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

export interface MetaPublishInput {
  pageId: string;
  pageToken: string;
  title: string;
  caption: string;
  hashtags: string | null;
  fileSize: number;
  mockScenario: MockScenario | null;
}

export interface ExperimentalMetaThumbnailInput {
  readonly fileName: string;
  readonly mimeType: "image/jpeg";
  readonly sizeBytes: number;
  readonly stream: Readable;
}

type MetaErrorBody = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
};

type MetaResponseBody = {
  error?: MetaErrorBody;
  upload_session_id?: string;
  video_id?: string;
  start_offset?: string | number;
  end_offset?: string | number;
  upload_url?: string;
  success?: boolean;
  status?: {
    video_status?: string;
    uploading_phase?: {
      status?: string;
      errors?: Array<{
        code?: number;
        error_subcode?: number;
        message?: string;
      }>;
    };
    processing_phase?: {
      status?: string;
      errors?: Array<{
        code?: number;
        error_subcode?: number;
        message?: string;
      }>;
    };
    publishing_phase?: {
      status?: string;
      errors?: Array<{
        code?: number;
        error_subcode?: number;
        message?: string;
      }>;
    };
  };
  raw?: string;
};

export class FacebookPublishingService {
  static getGraphApiVersion(): string {
    const configuredVersion =
      process.env.FACEBOOK_GRAPH_API_VERSION?.trim();

    if (!configuredVersion) {
      return 'v20.0';
    }

    return configuredVersion.startsWith('v')
      ? configuredVersion
      : `v${configuredVersion}`;
  }

  static getBaseUrl(): string {
    return `https://graph.facebook.com/${this.getGraphApiVersion()}`;
  }

  private static async readResponseBody(
    response: Response,
  ): Promise<MetaResponseBody> {
    const text = await response.text();

    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text) as MetaResponseBody;
    } catch {
      return {
        raw: text.slice(0, 500),
      };
    }
  }

  private static createMetaError(
    operation: string,
    response: Response,
    body: MetaResponseBody,
  ): Error {
    const metaError = body.error;
    const message =
      metaError?.message ||
      body.raw ||
      `${operation} failed`;

    const details = [
      `Status: ${response.status}`,
      metaError?.code !== undefined
        ? `Code: ${metaError.code}`
        : null,
      metaError?.error_subcode !== undefined
        ? `Subcode: ${metaError.error_subcode}`
        : null,
      metaError?.is_transient !== undefined
        ? `Transient: ${metaError.is_transient}`
        : null,
      metaError?.fbtrace_id
        ? `FBTrace: ${metaError.fbtrace_id}`
        : null,
    ].filter((value): value is string => Boolean(value));

    const isAuthError =
      response.status === 401 ||
      response.status === 403 ||
      metaError?.code === 190;

    const prefix = isAuthError
      ? 'META_AUTH_ERROR'
      : 'META_API_ERROR';

    return new Error(
      `${prefix}: ${message} (${details.join(', ')})`,
    );
  }

  private static ensureRuploadUrl(uploadUrl: string): string {
    let parsed: URL;

    try {
      parsed = new URL(uploadUrl);
    } catch {
      throw new Error(
        'META_INVALID_RESPONSE: Meta returned an invalid Reel upload URL.',
      );
    }

    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'rupload.facebook.com'
    ) {
      throw new Error(
        'META_INVALID_RESPONSE: Meta returned an untrusted Reel upload host.',
      );
    }

    return parsed.toString();
  }

  private static createMultipartField(
    boundary: string,
    name: string,
    value: string,
  ): Buffer {
    return Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
      'utf8',
    );
  }

  private static async readExperimentalThumbnail(
    thumbnail: ExperimentalMetaThumbnailInput,
  ): Promise<Buffer> {
    if (
      thumbnail.mimeType !== 'image/jpeg' ||
      !Number.isSafeInteger(thumbnail.sizeBytes) ||
      thumbnail.sizeBytes <= 0 ||
      thumbnail.sizeBytes > 10 * 1024 * 1024
    ) {
      throw new Error(
        'META_THUMBNAIL_INVALID_INPUT: The experimental thumbnail must be a JPEG of 10 MiB or less.',
      );
    }

    if (
      !thumbnail.fileName ||
      thumbnail.fileName.length > 255 ||
      /[\x00-\x1F\x7F]/.test(thumbnail.fileName) ||
      thumbnail.fileName.includes('/') ||
      thumbnail.fileName.includes('\\')
    ) {
      throw new Error(
        'META_THUMBNAIL_INVALID_INPUT: The experimental thumbnail filename is invalid.',
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of thumbnail.stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);

      totalBytes += buffer.length;

      if (
        totalBytes > thumbnail.sizeBytes ||
        totalBytes > 10 * 1024 * 1024
      ) {
        throw new Error(
          'META_THUMBNAIL_SIZE_MISMATCH: The experimental thumbnail exceeded its validated size.',
        );
      }

      chunks.push(buffer);
    }

    if (totalBytes !== thumbnail.sizeBytes) {
      throw new Error(
        'META_THUMBNAIL_SIZE_MISMATCH: The experimental thumbnail size did not match its validated metadata.',
      );
    }

    return Buffer.concat(
      chunks,
      totalBytes,
    );
  }

  static parseOffset(val: unknown): number {
    if (val === undefined || val === null) {
      throw new Error('META_OFFSET_MISSING: Offset is missing.');
    }
    const num = Number(val);
    if (!Number.isInteger(num) || num < 0 || Number.isNaN(num) || !Number.isFinite(num)) {
      throw new Error(`META_OFFSET_INVALID: Invalid offset value: ${String(val)}`);
    }
    return num;
  }

  // Existing regular Facebook Video resumable-upload flow.
  static async startUploadSession(
    pageId: string,
    pageToken: string,
    fileSize: number,
  ): Promise<{
    uploadSessionId: string;
    videoId: string;
    startOffset: number;
    endOffset: number;
  }> {
    const url = `${this.getBaseUrl()}/${pageId}/videos`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'start',
        access_token: pageToken,
        file_size: fileSize,
      }),
    });

    const body = await this.readResponseBody(response);

    if (!response.ok) {
      throw this.createMetaError(
        'Meta video start session',
        response,
        body,
      );
    }

    if (!body.upload_session_id || !body.video_id) {
      throw new Error(
        'META_INVALID_RESPONSE: Video start response is missing upload_session_id or video_id.',
      );
    }

    const startOffset = this.parseOffset(body.start_offset);
    const endOffset = this.parseOffset(body.end_offset);

    if (startOffset !== 0) {
      throw new Error(`META_OFFSET_INVALID: Initial start_offset must be 0, got ${startOffset}.`);
    }
    if (endOffset <= startOffset) {
      throw new Error(`META_OFFSET_INVALID: Initial end_offset ${endOffset} must be greater than start_offset.`);
    }
    if (endOffset > fileSize) {
      throw new Error(`META_OFFSET_INVALID: Initial end_offset ${endOffset} exceeds file size ${fileSize}.`);
    }

    return {
      uploadSessionId: body.upload_session_id,
      videoId: body.video_id,
      startOffset,
      endOffset,
    };
  }

  static async uploadChunk(
    pageId: string,
    pageToken: string,
    uploadSessionId: string,
    startOffset: number,
    chunkBuffer: Buffer,
  ): Promise<{
    startOffset: number;
    endOffset: number;
  }> {
    const url = `${this.getBaseUrl()}/${pageId}/videos`;
    const boundary =
      '----WebKitFormBoundary' +
      Math.random().toString(36).substring(2);

    const multipartHeader = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="upload_phase"\r\n\r\n` +
        `transfer\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="access_token"\r\n\r\n` +
        `${pageToken}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="upload_session_id"\r\n\r\n` +
        `${uploadSessionId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="start_offset"\r\n\r\n` +
        `${startOffset}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="video_file_chunk"; filename="chunk.mp4"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );

    const multipartFooter = Buffer.from(
      `\r\n--${boundary}--\r\n`,
    );

    const bodyBuffer = Buffer.concat([
      multipartHeader,
      chunkBuffer,
      multipartFooter,
    ]);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length.toString(),
      },
      body: bodyBuffer,
    });

    const body = await this.readResponseBody(response);

    if (!response.ok) {
      throw this.createMetaError(
        'Meta video chunk transfer',
        response,
        body,
      );
    }

    const nextStartOffset = this.parseOffset(body.start_offset);
    const nextEndOffset = this.parseOffset(body.end_offset);

    return {
      startOffset: nextStartOffset,
      endOffset: nextEndOffset,
    };
  }

  static async finishUploadSession(
    pageId: string,
    pageToken: string,
    uploadSessionId: string,
    title: string,
    caption: string,
    hashtags: string | null,
  ): Promise<void> {
    const url = `${this.getBaseUrl()}/${pageId}/videos`;
    const description = hashtags
      ? `${caption}\n\n${hashtags}`
      : caption;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'finish',
        access_token: pageToken,
        upload_session_id: uploadSessionId,
        title,
        description,
      }),
    });

    if (!response.ok) {
      const body = await this.readResponseBody(response);
      throw this.createMetaError(
        'Meta video finish session',
        response,
        body,
      );
    }
  }

  /**
   * Experimental regular-video finish request with the historical multipart
   * `thumb` field. This method is intentionally isolated and must only be
   * called after the explicit two-part capability gate is enabled.
   *
   * Current Meta Reels publishing documentation does not expose an equivalent
   * thumbnail parameter, so this method must never be used for Reels.
   */
  static async finishUploadSessionWithExperimentalThumbnail(
    pageId: string,
    pageToken: string,
    uploadSessionId: string,
    title: string,
    caption: string,
    hashtags: string | null,
    thumbnail: ExperimentalMetaThumbnailInput,
  ): Promise<void> {
    const url =
      `${this.getBaseUrl()}/${pageId}/videos`;

    const description = hashtags
      ? `${caption}\n\n${hashtags}`
      : caption;

    const boundary =
      `----FbPublisherThumbnail${
        randomBytes(18).toString('hex')
      }`;

    const thumbnailBytes =
      await this.readExperimentalThumbnail(
        thumbnail,
      );

    const thumbnailHeader = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="thumb"; filename="${thumbnail.fileName}"\r\n` +
        `Content-Type: ${thumbnail.mimeType}\r\n\r\n`,
      'utf8',
    );

    const body = Buffer.concat([
      this.createMultipartField(
        boundary,
        'upload_phase',
        'finish',
      ),
      this.createMultipartField(
        boundary,
        'access_token',
        pageToken,
      ),
      this.createMultipartField(
        boundary,
        'upload_session_id',
        uploadSessionId,
      ),
      this.createMultipartField(
        boundary,
        'title',
        title,
      ),
      this.createMultipartField(
        boundary,
        'description',
        description,
      ),
      thumbnailHeader,
      thumbnailBytes,
      Buffer.from(
        `\r\n--${boundary}--\r\n`,
        'utf8',
      ),
    ]);

    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':
            `multipart/form-data; boundary=${boundary}`,
          'Content-Length':
            body.length.toString(),
        },
        body,
      });
    } catch {
      throw new Error(
        'META_NETWORK_ERROR: Experimental thumbnail finish request failed.',
      );
    }

    if (!response.ok) {
      const responseBody =
        await this.readResponseBody(response);

      throw this.createMetaError(
        'Meta experimental video thumbnail finish session',
        response,
        responseBody,
      );
    }
  }

  // Current Facebook Reels Publishing API flow.
  static async startReelUploadSession(
    pageToken: string,
  ): Promise<{
    uploadUrl: string;
    videoId: string;
  }> {
    const url = new URL(
      `${this.getBaseUrl()}/me/video_reels`,
    );

    url.searchParams.set('access_token', pageToken);
    url.searchParams.set('upload_phase', 'start');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'FB-Multi-Page-Publisher/1.0',
      },
    });

    const body = await this.readResponseBody(response);

    if (!response.ok) {
      throw this.createMetaError(
        'Meta Reel start session',
        response,
        body,
      );
    }

    if (!body.video_id || !body.upload_url) {
      throw new Error(
        'META_INVALID_RESPONSE: Reel start response is missing video_id or upload_url.',
      );
    }

    return {
      videoId: body.video_id,
      uploadUrl: this.ensureRuploadUrl(body.upload_url),
    };
  }

  static async uploadReelMedia(
    uploadUrl: string,
    pageToken: string,
    fileSize: number,
    mediaStream: Readable,
  ): Promise<void> {
    const trustedUploadUrl =
      this.ensureRuploadUrl(uploadUrl);

    const webStream = Readable.toWeb(
      mediaStream,
    ) as unknown as BodyInit;

    const request: RequestInit & {
      duplex: 'half';
    } = {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${pageToken}`,
        offset: '0',
        file_size: fileSize.toString(),
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize.toString(),
        'User-Agent': 'FB-Multi-Page-Publisher/1.0',
      },
      body: webStream,
      duplex: 'half',
    };

    const response = await fetch(
      trustedUploadUrl,
      request,
    );

    const body = await this.readResponseBody(response);

    if (!response.ok) {
      throw this.createMetaError(
        'Meta Reel binary upload',
        response,
        body,
      );
    }

    if (body.success === false) {
      throw new Error(
        'META_API_ERROR: Meta Reel binary upload returned success=false.',
      );
    }
  }

  static async finishReelUploadSession(
    pageToken: string,
    videoId: string,
    title: string,
    caption: string,
    hashtags: string | null,
  ): Promise<void> {
    const url = new URL(
      `${this.getBaseUrl()}/me/video_reels`,
    );

    const description = hashtags
      ? `${caption}\n\n${hashtags}`
      : caption;

    url.searchParams.set('access_token', pageToken);
    url.searchParams.set('video_id', videoId);
    url.searchParams.set('upload_phase', 'finish');
    url.searchParams.set('video_state', 'PUBLISHED');
    url.searchParams.set('description', description);
    url.searchParams.set('title', title);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'FB-Multi-Page-Publisher/1.0',
      },
    });

    const body = await this.readResponseBody(response);

    if (!response.ok) {
      throw this.createMetaError(
        'Meta Reel finish session',
        response,
        body,
      );
    }

    if (body.success === false) {
      throw new Error(
        'META_API_ERROR: Meta Reel finish session returned success=false.',
      );
    }
  }

  static async checkVideoStatus(
    videoId: string,
    pageToken: string,
  ): Promise<{
    status: 'ready' | 'processing' | 'error';
    errorMsg?: string;
    errorDetails?: {
      code?: number;
      subcode?: number;
      message?: string;
      phase?: 'uploading' | 'processing' | 'publishing' | 'unknown';
    };
  }> {
    const url = new URL(
      `${this.getBaseUrl()}/${videoId}`,
    );

    url.searchParams.set('fields', 'status');
    url.searchParams.set('access_token', pageToken);

    const response = await fetch(url, {
      method: 'GET',
    });

    const body = await this.readResponseBody(response);

    if (!response.ok) {
      throw this.createMetaError(
        'Meta video status query',
        response,
        body,
      );
    }

    const videoStatus =
      body.status?.video_status;

    if (videoStatus === 'ready') {
      return {
        status: 'ready',
      };
    }

    if (videoStatus === 'processing') {
      return {
        status: 'processing',
      };
    }

    const uploadingPhase = body.status?.uploading_phase;
    const processingPhase = body.status?.processing_phase;
    const publishingPhase = body.status?.publishing_phase;

    let foundError: {
      code?: number;
      subcode?: number;
      message?: string;
      phase: 'uploading' | 'processing' | 'publishing';
    } | null = null;

    if (uploadingPhase?.errors && uploadingPhase.errors.length > 0) {
      foundError = {
        code: uploadingPhase.errors[0].code,
        subcode: uploadingPhase.errors[0].error_subcode,
        message: uploadingPhase.errors[0].message,
        phase: 'uploading',
      };
    } else if (processingPhase?.errors && processingPhase.errors.length > 0) {
      foundError = {
        code: processingPhase.errors[0].code,
        subcode: processingPhase.errors[0].error_subcode,
        message: processingPhase.errors[0].message,
        phase: 'processing',
      };
    } else if (publishingPhase?.errors && publishingPhase.errors.length > 0) {
      foundError = {
        code: publishingPhase.errors[0].code,
        subcode: publishingPhase.errors[0].error_subcode,
        message: publishingPhase.errors[0].message,
        phase: 'publishing',
      };
    }

    if (foundError) {
      const parts: string[] = [];
      if (foundError.message) parts.push(foundError.message);
      if (foundError.code !== undefined) parts.push(`Code: ${foundError.code}`);
      if (foundError.subcode !== undefined) parts.push(`Subcode: ${foundError.subcode}`);
      parts.push(`Phase: ${foundError.phase}`);

      return {
        status: 'error',
        errorMsg: `Meta video status=error; ${parts.join('; ')}`,
        errorDetails: {
          code: foundError.code,
          subcode: foundError.subcode,
          message: foundError.message,
          phase: foundError.phase,
        },
      };
    }

    const fallbackMsg = `Meta video status=error; uploading_phase=${uploadingPhase?.status || 'unknown'}; processing_phase=${processingPhase?.status || 'unknown'}; publishing_phase=${publishingPhase?.status || 'unknown'}; Meta returned no phase error details.`;
    return {
      status: 'error',
      errorMsg: fallbackMsg,
      errorDetails: {
        phase: 'unknown',
      },
    };
  }
}
