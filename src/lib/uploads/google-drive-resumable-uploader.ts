import { BrowserUploaderStatus, BrowserUploadState, VideoMetadata, UploadFileLike } from './upload-types';

export interface GoogleUploadTransportRequest {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  body: XMLHttpRequestBodyInit | null;
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
}

export interface GoogleUploadTransportResponse {
  status: number;
  headers: {
    get: (name: string) => string | null;
  };
  body: string;
}

export interface GoogleUploadTransport {
  send(req: GoogleUploadTransportRequest): Promise<GoogleUploadTransportResponse>;
}

export class XmlHttpUploadTransport implements GoogleUploadTransport {
  async send(req: GoogleUploadTransportRequest): Promise<GoogleUploadTransportResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(req.method, req.url, true);

      for (const [key, value] of Object.entries(req.headers)) {
        xhr.setRequestHeader(key, value);
      }

      if (req.onProgress && xhr.upload) {
        xhr.upload.onprogress = req.onProgress;
      }

      let settled = false;

      const cleanup = () => {
        if (req.signal && onAbort) {
          req.signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        xhr.abort();
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      if (req.signal) {
        if (req.signal.aborted) {
          settled = true;
          return reject(new DOMException('Aborted', 'AbortError'));
        }
        req.signal.addEventListener('abort', onAbort);
      }

      xhr.onload = () => {
        if (settled) return;
        settled = true;
        cleanup();

        const headersMap = new Map<string, string>();
        const allHeaders = xhr.getAllResponseHeaders();
        if (allHeaders) {
          allHeaders.split('\r\n').forEach((line) => {
            const parts = line.split(': ');
            if (parts.length >= 2) {
              const name = parts[0].toLowerCase();
              const value = parts.slice(1).join(': ');
              headersMap.set(name, value);
            }
          });
        }

        resolve({
          status: xhr.status,
          headers: {
            get: (name: string) => headersMap.get(name.toLowerCase()) ?? xhr.getResponseHeader(name),
          },
          body: xhr.responseText || '',
        });
      };

      xhr.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Network request failed'));
      };

      xhr.onabort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      xhr.send(req.body);
    });
  }
}

export interface GoogleDriveResumableUploaderOptions {
  file: UploadFileLike;
  assetId: string;
  sessionUri: string;
  recoveryKey: string;
  onStatusChange?: (status: BrowserUploaderStatus) => void;
  maxRetries?: number;
  retryBackoffMs?: number;
  transport?: GoogleUploadTransport;
}

export interface GoogleInitiationResponse {
  provider: 'GOOGLE_DRIVE';
  assetId: string;
  sessionUri: string;
  filename: string;
  mimeType: string;
  totalBytes: string;
  idempotentReplay: boolean;
}

export interface RecoveryRecord {
  version: 2;
  provider: 'GOOGLE_DRIVE';
  assetId: string;
  sessionUri: string;
  filename: string;
  mimeType: string;
  totalBytes: string;
  lastModified: number;
}

export interface LegacyR2RecoveryRecord {
  assetId: string;
}

export interface ResolvedRecovery {
  provider: 'R2' | 'GOOGLE_DRIVE';
  assetId: string;
  sessionUri?: string;
}

// -------------------------------------------------------------
// Runtime JSON Validators & Parsers
// -------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseRecoveryRecord(value: unknown): RecoveryRecord | null {
  if (!isRecord(value)) return null;

  const version = value.version;
  const provider = value.provider;
  const assetId = value.assetId;
  const sessionUri = value.sessionUri;
  const filename = value.filename;
  const mimeType = value.mimeType;
  const totalBytes = value.totalBytes;
  const lastModified = value.lastModified;

  if (
    version === 2 &&
    provider === 'GOOGLE_DRIVE' &&
    typeof assetId === 'string' && assetId !== '' &&
    typeof sessionUri === 'string' && sessionUri.startsWith('https://') &&
    typeof filename === 'string' &&
    typeof mimeType === 'string' &&
    typeof totalBytes === 'string' &&
    typeof lastModified === 'number'
  ) {
    return {
      version: 2,
      provider: 'GOOGLE_DRIVE',
      assetId,
      sessionUri,
      filename,
      mimeType,
      totalBytes,
      lastModified,
    };
  }
  return null;
}

export function parseLegacyR2RecoveryRecord(value: unknown): LegacyR2RecoveryRecord | null {
  if (!isRecord(value)) return null;
  const assetId = value.assetId;
  if (typeof assetId === 'string' && assetId !== '' && value.version === undefined && value.provider === undefined) {
    return { assetId };
  }
  return null;
}

export function matchRecoveryRecord(
  storedString: string,
  file: UploadFileLike,
  recoveryKey: string
): ResolvedRecovery | null {
  try {
    const parsed: unknown = JSON.parse(storedString);
    if (!isRecord(parsed)) return null;

    const version = parsed.version;
    const provider = parsed.provider;

    if (version === 2 && provider === 'GOOGLE_DRIVE') {
      const record = parseRecoveryRecord(parsed);
      if (!record) {
        localStorage.removeItem(`upload_recovery_${recoveryKey}`);
        return null;
      }

      const matches =
        record.filename === file.name &&
        record.totalBytes === file.size.toString() &&
        record.mimeType === (file.type || 'video/mp4') &&
        record.lastModified === file.lastModified;

      if (matches) {
        return {
          provider: 'GOOGLE_DRIVE',
          assetId: record.assetId,
          sessionUri: record.sessionUri,
        };
      } else {
        localStorage.removeItem(`upload_recovery_${recoveryKey}`);
        return null;
      }
    }

    const r2Record = parseLegacyR2RecoveryRecord(parsed);
    if (r2Record) {
      return {
        provider: 'R2',
        assetId: r2Record.assetId,
      };
    }
  } catch {
    // Ignore JSON errors
  }
  return null;
}

export function parseGoogleInitiationResponse(
  value: unknown,
  file: UploadFileLike
): GoogleInitiationResponse {
  if (!isRecord(value)) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }

  const provider = value.provider;
  const assetId = value.assetId;
  const sessionUri = value.sessionUri;
  const filename = value.filename;
  const mimeType = value.mimeType;
  const totalBytes = value.totalBytes;
  const idempotentReplay = value.idempotentReplay;

  if (provider !== 'GOOGLE_DRIVE') {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  if (typeof assetId !== 'string' || assetId === '') {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  if (typeof sessionUri !== 'string' || !sessionUri.startsWith('https://')) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  if (typeof filename !== 'string' || filename !== file.name) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  const expectedMime = file.type || 'video/mp4';
  if (typeof mimeType !== 'string' || mimeType !== expectedMime) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  if (typeof totalBytes !== 'string' || totalBytes !== file.size.toString()) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  if (typeof idempotentReplay !== 'boolean') {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }

  return {
    provider: 'GOOGLE_DRIVE',
    assetId,
    sessionUri,
    filename,
    mimeType,
    totalBytes,
    idempotentReplay,
  };
}

export function parseDriveFileId(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  const id = value.id;
  if (typeof id !== 'string' || id === '' || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  return id;
}

// -------------------------------------------------------------
// Safe Range Parsing
// -------------------------------------------------------------

export function parseRangeHeader(
  rangeHeader: string | null,
  totalSize: number
): number {
  if (!rangeHeader) {
    return 0;
  }

  const match = rangeHeader.trim().match(/^bytes=0-(\d+)$/);
  if (!match) {
    throw new Error('GOOGLE_DRIVE_INVALID_RESUME_RANGE');
  }

  const n = parseInt(match[1], 10);
  if (isNaN(n) || n < 0 || !Number.isInteger(n) || n + 1 > totalSize) {
    throw new Error('GOOGLE_DRIVE_INVALID_RESUME_RANGE');
  }

  return n + 1;
}

// -------------------------------------------------------------
// Stable Error Mapping Allowlist
// -------------------------------------------------------------

const SAFE_ERRORS = new Set([
  'GOOGLE_DRIVE_UPLOAD_FAILED',
  'GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED',
  'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE',
  'UPLOAD_SESSION_EXPIRED',
  'UPLOAD_SESSION_RESTART_REQUIRED',
  'GOOGLE_DRIVE_INVALID_RESUME_RANGE',
]);

export function redactError(err: unknown): Error {
  if (err instanceof Error) {
    if (SAFE_ERRORS.has(err.message)) {
      return new Error(err.message);
    }
  }
  return new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
}

// -------------------------------------------------------------
// GoogleDriveResumableUploader
// -------------------------------------------------------------

export class GoogleDriveResumableUploader {
  private file: UploadFileLike;
  private assetId: string;
  private sessionUri: string;
  private recoveryKey: string;
  private onStatusChange?: (status: BrowserUploaderStatus) => void;
  private maxRetries: number;
  private retryBackoffMs: number;
  private transport: GoogleUploadTransport;

  private state: BrowserUploadState = 'idle';
  private uploadedBytes = 0;
  private unchangedOffsetCount = 0;

  private activeController: AbortController | null = null;
  private activeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private isPaused = false;
  private isAborted = false;
  private isReconciling = false;
  private reconciliationAttempted = false;

  private readonly CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB

  constructor(options: GoogleDriveResumableUploaderOptions) {
    this.file = options.file;
    this.assetId = options.assetId;
    this.sessionUri = options.sessionUri;
    this.recoveryKey = options.recoveryKey;
    this.onStatusChange = options.onStatusChange;
    this.maxRetries = options.maxRetries ?? 5;
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;
    this.transport = options.transport ?? new XmlHttpUploadTransport();

    if (this.CHUNK_SIZE % (256 * 1024) !== 0) {
      throw new Error('Invalid chunk size constant: must be a multiple of 256 KiB.');
    }
  }

  public getStatus(): BrowserUploaderStatus {
    return {
      state: this.state,
      progressPercent: this.file.size > 0 ? Math.round((this.uploadedBytes / this.file.size) * 100) : 0,
      uploadedBytes: this.uploadedBytes,
      totalBytes: this.file.size,
      assetId: this.assetId,
      provider: 'GOOGLE_DRIVE',
    };
  }

  private emit(updates: Partial<BrowserUploaderStatus>) {
    const currentStatus = this.getStatus();
    const newStatus = { ...currentStatus, ...updates };

    if (updates.state) this.state = updates.state;

    if (this.onStatusChange) {
      this.onStatusChange(newStatus);
    }
  }

  private clearStorage() {
    try {
      localStorage.removeItem(`upload_recovery_${this.recoveryKey}`);
    } catch {
      // Ignore
    }
  }

  public async start(options?: { isRetryOrResume?: boolean }) {
    if (this.state !== 'idle' && this.state !== 'selected' && this.state !== 'paused') return;
    this.isPaused = false;
    this.isAborted = false;
    this.reconciliationAttempted = false;

    try {
      this.emit({ state: 'initiating' });

      // 1. Fetch server state first if this is a retry or resume/recovery attempt
      if (options?.isRetryOrResume) {
        try {
          this.activeController = new AbortController();
          const serverCheckResponse = await fetch(`/api/uploads/${this.assetId}`, {
            signal: this.activeController.signal,
          });

          if (serverCheckResponse.ok) {
            const checkData: unknown = await serverCheckResponse.json();
            const parsedStatus = parseValidationStatus(checkData);
            if (parsedStatus.status === 'VALIDATING') {
              this.emit({ state: 'validating' });
              this.startValidationPolling();
              return;
            } else if (parsedStatus.status === 'VALIDATED') {
              const metadata: VideoMetadata = {
                durationMs: parsedStatus.durationMs,
                width: parsedStatus.width,
                height: parsedStatus.height,
                frameRate: parsedStatus.frameRate,
                videoCodec: parsedStatus.videoCodec,
                audioCodec: parsedStatus.audioCodec,
                containerFormat: parsedStatus.containerFormat,
                detectedMimeType: parsedStatus.detectedMimeType,
              };
              this.clearStorage();
              this.emit({ state: 'validated', metadata });
              return;
            }
          }
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          // Ignore server check errors and proceed with normal resume/retry flow
        }
      }

      // Write Google Drive recovery record (version 2)
      try {
        const record: RecoveryRecord = {
          version: 2,
          provider: 'GOOGLE_DRIVE',
          assetId: this.assetId,
          sessionUri: this.sessionUri,
          filename: this.file.name,
          mimeType: this.file.type || 'video/mp4',
          totalBytes: this.file.size.toString(),
          lastModified: this.file.lastModified,
        };
        localStorage.setItem(`upload_recovery_${this.recoveryKey}`, JSON.stringify(record));
      } catch {
        // Ignore quota exceptions
      }

      const startOffset = await this.querySessionStatusWithRetry();
      this.uploadedBytes = startOffset;
      this.emit({ state: 'uploading' });

      await this.uploadLoop(startOffset);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;

      if (!this.isPaused && !this.isAborted && !this.reconciliationAttempted && this.isNetworkOrStatus0Error(err)) {
        this.reconciliationAttempted = true;
        try {
          const reconciled = await this.attemptServerReconciliation();
          if (reconciled) {
            return;
          }
        } catch (reconErr: unknown) {
          if (reconErr instanceof DOMException && reconErr.name === 'AbortError') {
            return;
          }
          const cleanReconErr = redactError(reconErr);
          this.emit({ state: 'failed', error: cleanReconErr.message });
          this.clearStorage();
          throw cleanReconErr;
        }
      }

      const cleanErr = redactError(err);
      this.emit({ state: 'failed', error: cleanErr.message });
      this.clearStorage();
      throw cleanErr;
    }
  }

  private isNetworkOrStatus0Error(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message;
      return (
        msg === 'GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED' ||
        msg === 'Network request failed' ||
        msg.includes('HTTP 0') ||
        msg.includes('code 0')
      );
    }
    return false;
  }

  private async attemptServerReconciliation(): Promise<boolean> {
    if (this.isPaused || this.isAborted || this.isReconciling) {
      return false;
    }

    this.isReconciling = true;
    try {
      this.activeController = new AbortController();
      const response = await fetch(`/api/uploads/${this.assetId}/reconcile`, {
        method: 'POST',
        signal: this.activeController.signal,
      });

      if (response.status === 404 || response.status === 410) {
        throw new Error('UPLOAD_SESSION_EXPIRED');
      }
      if (response.status >= 400 && response.status < 500) {
        throw new Error('UPLOAD_SESSION_RESTART_REQUIRED');
      }
      if (!response.ok) {
        throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
      }

      const data: unknown = await response.json();
      if (!isRecord(data)) {
        throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
      }

      const serverStatus = data.status;
      if (serverStatus === 'VALIDATING') {
        this.emit({ state: 'validating' });
        this.startValidationPolling();
        return true;
      } else if (serverStatus === 'VALIDATED') {
        const checkResponse = await fetch(`/api/uploads/${this.assetId}`, {
          signal: this.activeController.signal,
        });
        if (!checkResponse.ok) {
          throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
        }
        const checkData: unknown = await checkResponse.json();
        const parsed = parseValidationStatus(checkData);
        if (parsed.status === 'VALIDATED') {
          const metadata: VideoMetadata = {
            durationMs: parsed.durationMs,
            width: parsed.width,
            height: parsed.height,
            frameRate: parsed.frameRate,
            videoCodec: parsed.videoCodec,
            audioCodec: parsed.audioCodec,
            containerFormat: parsed.containerFormat,
            detectedMimeType: parsed.detectedMimeType,
          };
          this.clearStorage();
          this.emit({ state: 'validated', metadata });
          return true;
        }
        throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
      }
    } finally {
      this.isReconciling = false;
    }
    return false;
  }

  public async querySessionStatus(): Promise<number> {
    const response = await this.transport.send({
      method: 'PUT',
      url: this.sessionUri,
      headers: {
        'Content-Length': '0',
        'Content-Range': `bytes */${this.file.size}`,
      },
      body: null,
      signal: this.activeController?.signal,
    });

    if (response.status === 308) {
      const range = response.headers.get('Range');
      return parseRangeHeader(range, this.file.size);
    }

    if (response.status === 200 || response.status === 201) {
      const parsed: unknown = JSON.parse(response.body);
      const driveFileId = parseDriveFileId(parsed);

      await this.triggerCompleteAPI(driveFileId);
      return this.file.size;
    }

    if (response.status === 404 || response.status === 410) {
      throw new Error('UPLOAD_SESSION_EXPIRED');
    }

    if (response.status >= 400 && response.status < 500) {
      throw new Error('UPLOAD_SESSION_RESTART_REQUIRED');
    }

    throw new Error(`Session query status failed with code ${response.status}`);
  }

  private async querySessionStatusWithRetry(): Promise<number> {
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      if (this.isPaused || this.isAborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      try {
        this.activeController = new AbortController();
        if (attempt > 0) {
          this.emit({ state: 'retrying', retryAttempt: attempt });
          const backoffTime = this.retryBackoffMs * Math.pow(2, attempt - 1);
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            this.activeController?.signal.addEventListener('abort', onAbort);
            this.activeTimeoutId = setTimeout(() => {
              this.activeController?.signal.removeEventListener('abort', onAbort);
              resolve();
            }, backoffTime);
          });
        }

        return await this.querySessionStatus();
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        if (err instanceof Error && (err.message === 'UPLOAD_SESSION_EXPIRED' || err.message === 'UPLOAD_SESSION_RESTART_REQUIRED')) {
          throw err;
        }

        attempt++;
        if (attempt > this.maxRetries) {
          throw new Error('GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED');
        }
      }
    }
    throw new Error('GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED');
  }

  private async uploadLoop(startOffset: number) {
    let offset = startOffset;

    while (offset < this.file.size) {
      if (this.isPaused || this.isAborted) return;

      const end = Math.min(offset + this.CHUNK_SIZE, this.file.size);
      const length = end - offset;

      if (end < this.file.size && length % (256 * 1024) !== 0) {
        throw new Error('Invalid chunk size alignment: non-final chunks must be multiples of 256 KiB.');
      }

      const chunk = this.file.slice(offset, end);
      let success = false;
      let attempt = 0;

      while (!success && attempt <= this.maxRetries) {
        if (this.isPaused || this.isAborted) return;

        try {
          this.activeController = new AbortController();

          if (attempt > 0) {
            this.emit({ state: 'retrying', retryAttempt: attempt });
            const backoffTime = this.retryBackoffMs * Math.pow(2, attempt - 1);
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
                reject(new DOMException('Aborted', 'AbortError'));
              };
              this.activeController?.signal.addEventListener('abort', onAbort);
              this.activeTimeoutId = setTimeout(() => {
                this.activeController?.signal.removeEventListener('abort', onAbort);
                resolve();
              }, backoffTime);
            });

            const freshOffset = await this.querySessionStatusWithRetry();
            if (freshOffset >= this.file.size) {
              return;
            }
            offset = freshOffset;
            this.uploadedBytes = offset;
            this.emit({ state: 'uploading' });

            const retryEnd = Math.min(offset + this.CHUNK_SIZE, this.file.size);
            const retryLength = retryEnd - offset;
            if (retryEnd < this.file.size && retryLength % (256 * 1024) !== 0) {
              throw new Error('Invalid chunk size alignment: non-final chunks must be multiples of 256 KiB.');
            }
            const retryChunk = this.file.slice(offset, retryEnd);

            await this.sendPut(offset, retryEnd, retryLength, retryChunk);
            success = true;
          } else {
            await this.sendPut(offset, end, length, chunk);
            success = true;
          }
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          attempt++;
          if (attempt > this.maxRetries) {
            throw err;
          }
        }
      }

      const newOffset = this.uploadedBytes;
      if (newOffset === offset) {
        this.unchangedOffsetCount++;
        if (this.unchangedOffsetCount >= 3) {
          throw new Error('Upload progress stalled: Google Drive returned an unchanged or backwards offset.');
        }
      } else {
        this.unchangedOffsetCount = 0;
      }

      offset = newOffset;
    }
  }

  private async sendPut(start: number, end: number, length: number, data: Blob) {
    const response = await this.transport.send({
      method: 'PUT',
      url: this.sessionUri,
      headers: {
        'Content-Type': this.file.type || 'video/mp4',
        'Content-Length': length.toString(),
        'Content-Range': `bytes ${start}-${end - 1}/${this.file.size}`,
      },
      body: data,
      onProgress: (event) => {
        if (event.lengthComputable && !this.isPaused && !this.isAborted) {
          const loaded = start + event.loaded;
          this.uploadedBytes = Math.min(loaded, end);
          this.emit({
            state: 'uploading',
            uploadedBytes: this.uploadedBytes,
          });
        }
      },
      signal: this.activeController?.signal,
    });

    if (response.status === 308) {
      const range = response.headers.get('Range');
      const parsedOffset = parseRangeHeader(range, this.file.size);
      this.uploadedBytes = parsedOffset;
      this.emit({
        state: 'uploading',
        uploadedBytes: parsedOffset,
      });
      return;
    }

    if (response.status === 200 || response.status === 201) {
      const parsed: unknown = JSON.parse(response.body);
      const driveFileId = parseDriveFileId(parsed);

      this.uploadedBytes = this.file.size;
      this.emit({
        state: 'uploading',
        uploadedBytes: this.file.size,
      });

      await this.triggerCompleteAPI(driveFileId);
      return;
    }

    if (response.status === 404 || response.status === 410) {
      throw new Error('UPLOAD_SESSION_EXPIRED');
    }

    if (response.status >= 400 && response.status < 500) {
      throw new Error('UPLOAD_SESSION_RESTART_REQUIRED');
    }

    throw new Error(`Upload request failed with HTTP ${response.status}`);
  }

  private async triggerCompleteAPI(driveFileId: string) {
    try {
      this.emit({ state: 'completing' });
      this.activeController = new AbortController();

      const response = await fetch(`/api/uploads/${this.assetId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ driveFileId }),
        signal: this.activeController.signal,
      });

      if (!response.ok) {
        throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
      }

      this.emit({ state: 'validating' });
      this.startValidationPolling();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const cleanErr = redactError(err);
      this.emit({ state: 'failed', error: cleanErr.message });
      throw cleanErr;
    }
  }

  private startValidationPolling() {
    let attempts = 0;
    const maxPollAttempts = 300;

    const poll = async () => {
      if (this.isPaused || this.isAborted) return;
      attempts++;

      try {
        this.activeController = new AbortController();
        const response = await fetch(`/api/uploads/${this.assetId}`, {
          signal: this.activeController.signal,
        });

        if (!response.ok) {
          throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
        }

        const data: unknown = await response.json();
        const parsed = parseValidationStatus(data);
        const serverStatus = parsed.status;

        if (serverStatus === 'VALIDATED') {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.clearStorage();

          const metadata: VideoMetadata = {
            durationMs: parsed.durationMs,
            width: parsed.width,
            height: parsed.height,
            frameRate: parsed.frameRate,
            videoCodec: parsed.videoCodec,
            audioCodec: parsed.audioCodec,
            containerFormat: parsed.containerFormat,
            detectedMimeType: parsed.detectedMimeType,
          };

          this.emit({ state: 'validated', metadata });
        } else if (serverStatus === 'FAILED') {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'failed', error: 'GOOGLE_DRIVE_UPLOAD_FAILED' });
        } else if (serverStatus === 'ABORTED') {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'aborted' });
        } else if (attempts >= maxPollAttempts) {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'failed', error: 'GOOGLE_DRIVE_UPLOAD_FAILED' });
        }
      } catch (err: unknown) {
        if (attempts >= maxPollAttempts) {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          const cleanErr = redactError(err);
          this.emit({ state: 'failed', error: cleanErr.message });
        }
      }
    };

    poll();
    this.pollIntervalId = setInterval(poll, 2000);
  }

  public pause() {
    if (this.state !== 'uploading' && this.state !== 'retrying' && this.state !== 'initiating') return;
    this.isPaused = true;

    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);

    this.emit({ state: 'paused' });
  }

  public async resume() {
    if (this.state !== 'paused') return;
    this.state = 'idle';
    await this.start({ isRetryOrResume: true });
  }

  public async cancel() {
    if (this.isAborted) return;
    this.isAborted = true;

    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);

    try {
      this.emit({ state: 'aborting' });
      this.activeController = new AbortController();

      const response = await fetch(`/api/uploads/${this.assetId}/abort`, {
        method: 'POST',
        signal: this.activeController.signal,
      });

      if (!response.ok) {
        throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
      }

      this.clearStorage();
      this.emit({ state: 'aborted' });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const cleanErr = redactError(err);
      this.emit({ state: 'failed', error: cleanErr.message });
      throw cleanErr;
    }
  }

  public async retry() {
    if (this.state !== 'failed') return;
    this.state = 'idle';
    await this.start({ isRetryOrResume: true });
  }

  public destroy() {
    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);
  }
}

export interface ValidationStatus {
  status: string;
  durationMs?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  containerFormat?: string;
  detectedMimeType?: string;
  failureMessage?: string;
  failureCode?: string;
}

export function parseValidationStatus(value: unknown): ValidationStatus {
  if (!isRecord(value)) {
    throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
  }
  const status = value.status;
  if (typeof status !== 'string') {
    throw new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
  }

  const result: ValidationStatus = { status };

  if (typeof value.durationMs === 'number' || typeof value.durationMs === 'string') {
    result.durationMs = Number(value.durationMs);
  }
  if (typeof value.width === 'number' || typeof value.width === 'string') {
    result.width = Number(value.width);
  }
  if (typeof value.height === 'number' || typeof value.height === 'string') {
    result.height = Number(value.height);
  }
  if (typeof value.frameRate === 'number' || typeof value.frameRate === 'string') {
    result.frameRate = Number(value.frameRate);
  }
  if (typeof value.videoCodec === 'string') {
    result.videoCodec = value.videoCodec;
  }
  if (typeof value.audioCodec === 'string') {
    result.audioCodec = value.audioCodec;
  }
  if (typeof value.containerFormat === 'string') {
    result.containerFormat = value.containerFormat;
  }
  if (typeof value.detectedMimeType === 'string') {
    result.detectedMimeType = value.detectedMimeType;
  }
  if (typeof value.failureMessage === 'string') {
    result.failureMessage = value.failureMessage;
  }
  if (typeof value.failureCode === 'string') {
    result.failureCode = value.failureCode;
  }

  return result;
}
