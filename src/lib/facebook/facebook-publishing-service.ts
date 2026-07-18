import { MockScenario } from '@prisma/client';

export interface MetaPublishInput {
  pageId: string;
  pageToken: string;
  title: string;
  caption: string;
  hashtags: string | null;
  fileSize: number;
  mockScenario: MockScenario | null;
}

export class FacebookPublishingService {
  static getGraphApiVersion(): string {
    const configuredVersion = process.env.FACEBOOK_GRAPH_API_VERSION?.trim();
    if (!configuredVersion) {
      return 'v20.0';
    }
    return configuredVersion.startsWith('v') ? configuredVersion : `v${configuredVersion}`;
  }

  static getBaseUrl(): string {
    return `https://graph.facebook.com/${this.getGraphApiVersion()}`;
  }

  // 1. Start Phase
  static async startUploadSession(
    pageId: string,
    pageToken: string,
    fileSize: number
  ): Promise<{ uploadSessionId: string; videoId: string }> {
    const url = `${this.getBaseUrl()}/${pageId}/videos`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upload_phase: 'start',
        access_token: pageToken,
        file_size: fileSize,
      }),
    });

    if (response.status === 401 || response.status === 403) {
      const errBody = await response.json().catch(() => ({}));
      const errorMsg = errBody?.error?.message || 'Unauthorized page access';
      throw new Error(`META_AUTH_ERROR: ${errorMsg}`);
    }

    if (response.status < 200 || response.status >= 300) {
      const errBody = await response.json().catch(() => ({}));
      const errorMsg = errBody?.error?.message || 'Meta start session failed';
      throw new Error(`META_API_ERROR: ${errorMsg} (Status: ${response.status})`);
    }

    const data = await response.json();
    if (!data.upload_session_id || !data.video_id) {
      throw new Error('META_INVALID_RESPONSE: start response is missing upload_session_id or video_id.');
    }

    return {
      uploadSessionId: data.upload_session_id,
      videoId: data.video_id,
    };
  }

  // 2. Transfer Phase Chunk Upload
  static async uploadChunk(
    pageId: string,
    pageToken: string,
    uploadSessionId: string,
    startOffset: number,
    chunkBuffer: Buffer
  ): Promise<void> {
    const url = `${this.getBaseUrl()}/${pageId}/videos`;
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

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
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const multipartFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuffer = Buffer.concat([multipartHeader, chunkBuffer, multipartFooter]);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length.toString(),
      },
      body: bodyBuffer,
    });

    if (response.status < 200 || response.status >= 300) {
      const errBody = await response.json().catch(() => ({}));
      const errorMsg = errBody?.error?.message || 'Meta transfer chunk failed';
      throw new Error(`META_API_ERROR: ${errorMsg} (Status: ${response.status})`);
    }
  }

  // 3. Finish Phase
  static async finishUploadSession(
    pageId: string,
    pageToken: string,
    uploadSessionId: string,
    title: string,
    caption: string,
    hashtags: string | null
  ): Promise<void> {
    const url = `${this.getBaseUrl()}/${pageId}/videos`;
    const description = hashtags ? `${caption}\n\n${hashtags}` : caption;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upload_phase: 'finish',
        access_token: pageToken,
        upload_session_id: uploadSessionId,
        title: title,
        description: description,
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      const errBody = await response.json().catch(() => ({}));
      const errorMsg = errBody?.error?.message || 'Meta finish session failed';
      throw new Error(`META_API_ERROR: ${errorMsg} (Status: ${response.status})`);
    }
  }

  // 4. Poll / Query video status
  static async checkVideoStatus(
    videoId: string,
    pageToken: string
  ): Promise<{ status: 'ready' | 'processing' | 'error'; errorMsg?: string }> {
    const url = `${this.getBaseUrl()}/${videoId}?fields=status&access_token=${pageToken}`;
    const response = await fetch(url, { method: 'GET' });

    if (response.status < 200 || response.status >= 300) {
      const errBody = await response.json().catch(() => ({}));
      const errorMsg = errBody?.error?.message || 'Meta query video status failed';
      throw new Error(`META_API_ERROR: ${errorMsg} (Status: ${response.status})`);
    }

    const data = await response.json();
    const videoStatus = data?.status?.video_status;
    if (videoStatus === 'ready') {
      return { status: 'ready' };
    }
    if (videoStatus === 'processing') {
      return { status: 'processing' };
    }
    const processingErr = data?.status?.processing_phase?.errors?.[0]?.message || 'Meta transcoding failed';
    return { status: 'error', errorMsg: processingErr };
  }
}
