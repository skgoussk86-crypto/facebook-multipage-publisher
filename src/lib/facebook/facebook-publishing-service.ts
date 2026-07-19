import { MockScenario } from '@prisma/client';
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
  upload_url?: string;
  success?: boolean;
  status?: {
    video_status?: string;
    processing_phase?: {
      errors?: Array<{
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

  // Existing regular Facebook Video resumable-upload flow.
  static async startUploadSession(
    pageId: string,
    pageToken: string,
    fileSize: number,
  ): Promise<{
    uploadSessionId: string;
    videoId: string;
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

    return {
      uploadSessionId: body.upload_session_id,
      videoId: body.video_id,
    };
  }

  static async uploadChunk(
    pageId: string,
    pageToken: string,
    uploadSessionId: string,
    startOffset: number,
    chunkBuffer: Buffer,
  ): Promise<void> {
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

    if (!response.ok) {
      const body = await this.readResponseBody(response);
      throw this.createMetaError(
        'Meta video chunk transfer',
        response,
        body,
      );
    }
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

    const processingError =
      body.status?.processing_phase?.errors?.[0]
        ?.message || 'Meta transcoding failed';

    return {
      status: 'error',
      errorMsg: processingError,
    };
  }
}
