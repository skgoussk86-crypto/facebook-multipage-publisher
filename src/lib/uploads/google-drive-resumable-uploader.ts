import { BrowserUploaderStatus, BrowserUploadState, MediaMetadata, UploadFileLike, getUploadFileMimeType } from './upload-types';

export interface GoogleUploadTransportRequest {
  method: 'PUT' | 'POST';
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
  recoveryKey: string;
  sessionUri?: string;
  onStatusChange?: (status: BrowserUploaderStatus) => void;
  maxRetries?: number;
  retryBackoffMs?: number;
  transport?: GoogleUploadTransport;
}

export interface GoogleInitiationResponse {
  provider: 'GOOGLE_DRIVE';
  assetId: string;
  filename: string;
  mimeType: string;
  totalBytes: string;
  idempotentReplay: boolean;
}

export interface RecoveryRecord {
  version: 3;
  provider: 'GOOGLE_DRIVE';
  assetId: string;
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
  const filename = value.filename;
  const mimeType = value.mimeType;
  const totalBytes = value.totalBytes;
  const lastModified = value.lastModified;

  if (
    version === 3 &&
    provider === 'GOOGLE_DRIVE' &&
    typeof assetId === 'string' && assetId !== '' &&
    typeof filename === 'string' &&
    typeof mimeType === 'string' &&
    typeof totalBytes === 'string' &&
    typeof lastModified === 'number'
  ) {
    return {
      version: 3,
      provider: 'GOOGLE_DRIVE',
      assetId,
      filename,
      mimeType,
      totalBytes,
      lastModified,
    };
  }
  return null;
}

export function parseVersion2RecoveryRecord(value: unknown): {
  version: 2;
  provider: 'GOOGLE_DRIVE';
  assetId: string;
  filename: string;
  mimeType: string;
  totalBytes: string;
  lastModified: number;
} | null {
  if (!isRecord(value)) return null;

  const version = value.version;
  const provider = value.provider;
  const assetId = value.assetId;
  const filename = value.filename;
  const mimeType = value.mimeType;
  const totalBytes = value.totalBytes;
  const lastModified = value.lastModified;

  if (
    version === 2 &&
    provider === 'GOOGLE_DRIVE' &&
    typeof assetId === 'string' && assetId !== '' &&
    typeof filename === 'string' &&
    typeof mimeType === 'string' &&
    typeof totalBytes === 'string' &&
    typeof lastModified === 'number'
  ) {
    return {
      version: 2,
      provider: 'GOOGLE_DRIVE',
      assetId,
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

    // Detect and scrub legacy version 2 records containing raw sessionUri
    if (version === 2 && provider === 'GOOGLE_DRIVE') {
      const record = parseVersion2RecoveryRecord(parsed);
      if (record) {
        const sanitizedRecord = {
          version: 3,
          provider: 'GOOGLE_DRIVE',
          assetId: record.assetId,
          filename: record.filename,
          mimeType: record.mimeType,
          totalBytes: record.totalBytes,
          lastModified: record.lastModified,
        };
        localStorage.setItem(`upload_recovery_${recoveryKey}`, JSON.stringify(sanitizedRecord));

        const matches =
          record.filename === file.name &&
          record.totalBytes === file.size.toString() &&
          record.mimeType === (getUploadFileMimeType(file)) &&
          record.lastModified === file.lastModified;

        if (matches) {
          return {
            provider: 'GOOGLE_DRIVE',
            assetId: record.assetId,
          };
        } else {
          localStorage.removeItem(`upload_recovery_${recoveryKey}`);
          return null;
        }
      } else {
        localStorage.removeItem(`upload_recovery_${recoveryKey}`);
        return null;
      }
    }

    if (version === 3 && provider === 'GOOGLE_DRIVE') {
      const record = parseRecoveryRecord(parsed);
      if (!record) {
        localStorage.removeItem(`upload_recovery_${recoveryKey}`);
        return null;
      }

      const matches =
        record.filename === file.name &&
        record.totalBytes === file.size.toString() &&
        record.mimeType === (getUploadFileMimeType(file)) &&
        record.lastModified === file.lastModified;

      if (matches) {
        return {
          provider: 'GOOGLE_DRIVE',
          assetId: record.assetId,
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
  if (typeof filename !== 'string' || filename !== file.name) {
    throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
  }
  const expectedMime = getUploadFileMimeType(file);
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

export const MAX_RETRY_AFTER_MS = 10000;

export function parseRetryAfterHeader(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();
  if (trimmed === '') return null;

  if (/^[+-]?\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || !Number.isSafeInteger(seconds)) {
      return null;
    }
    if (seconds < 0) {
      return null;
    }
    const ms = seconds * 1000;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }

  try {
    const parsedDate = Date.parse(trimmed);
    if (isNaN(parsedDate)) {
      return null;
    }
    const delayMs = parsedDate - Date.now();
    if (delayMs < 0) {
      return 0;
    }
    return Math.min(delayMs, MAX_RETRY_AFTER_MS);
  } catch {
    return null;
  }
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

export class GoogleDriveUploadError extends Error {
  constructor(message: string, public readonly isTerminal: boolean) {
    super(message);
    this.name = 'GoogleDriveUploadError';
  }
}

export function redactError(err: unknown): Error {
  if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === 'string' && SAFE_ERRORS.has(msg)) {
      return new Error(msg);
    }
  }
  if (typeof err === 'string' && SAFE_ERRORS.has(err)) {
    return new Error(err);
  }
  return new Error('GOOGLE_DRIVE_UPLOAD_FAILED');
}

// -------------------------------------------------------------
// GoogleDriveResumableUploader
// -------------------------------------------------------------

export class GoogleDriveResumableUploader {
  private file: UploadFileLike;
  private assetId: string;
  private recoveryKey: string;
  private sessionUri?: string;
  private onStatusChange?: (status: BrowserUploaderStatus) => void;
  private maxRetries: number;
  private retryBackoffMs: number;
  private transport: GoogleUploadTransport;

  private state: BrowserUploadState = 'idle';
  private uploadedBytes = 0;
  private unchangedOffsetCount = 0;
  private metadata?: MediaMetadata;

  private activeController: AbortController | null = null;
  private activeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private isPaused = false;
  private isAborted = false;
  private isReconciling = false;
  private immediateReconOffset: number | null = null;
  private terminalReconciliationAttempted = false;
  private lastRetryAfterMs: number | null = null;

  private readonly CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB

  constructor(options: GoogleDriveResumableUploaderOptions) {
    this.file = options.file;
    this.assetId = options.assetId;
    this.recoveryKey = options.recoveryKey;
    this.sessionUri = options.sessionUri;
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
      metadata: this.metadata,
    };
  }

  private emit(updates: Partial<BrowserUploaderStatus>) {
    if (updates.metadata) this.metadata = updates.metadata;
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
    this.immediateReconOffset = null;
    this.terminalReconciliationAttempted = false;
    this.lastRetryAfterMs = null;

    try {
      this.emit({ state: 'initiating' });

      // Write Google Drive recovery record (version 2 if sessionUri is present for legacy compatibility, else version 3)
      try {
        if (this.sessionUri) {
          const record = {
            version: 2,
            provider: 'GOOGLE_DRIVE',
            assetId: this.assetId,
            sessionUri: this.sessionUri,
            filename: this.file.name,
            mimeType: getUploadFileMimeType(this.file),
            totalBytes: this.file.size.toString(),
            lastModified: this.file.lastModified,
          };
          localStorage.setItem(`upload_recovery_${this.recoveryKey}`, JSON.stringify(record));
        } else {
          const record: RecoveryRecord = {
            version: 3,
            provider: 'GOOGLE_DRIVE',
            assetId: this.assetId,
            filename: this.file.name,
            mimeType: getUploadFileMimeType(this.file),
            totalBytes: this.file.size.toString(),
            lastModified: this.file.lastModified,
          };
          localStorage.setItem(`upload_recovery_${this.recoveryKey}`, JSON.stringify(record));
        }
      } catch {
        // Ignore quota exceptions
      }

      let startOffset = 0;
      if (options?.isRetryOrResume) {
        // 1. Fetch server state first if this is a retry or resume/recovery attempt
        try {
          this.activeController = new AbortController();
          const serverCheckResponse = await fetch(`/api/uploads/${this.assetId}`, {
            signal: this.activeController.signal,
          });

          if (serverCheckResponse.ok) {
            const checkData: unknown = await serverCheckResponse.json();
            const parsedStatus = parseValidationStatus(checkData);
            if (parsedStatus.status === 'VALIDATING') {
              await this.triggerValidateAndPoll();
              return;
            } else if (parsedStatus.status === 'VALIDATED') {
              const metadata: MediaMetadata = {
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

        startOffset = await this.querySessionStatusWithRetry();
        this.uploadedBytes = startOffset;
      }

      if (startOffset < this.file.size) {
        this.emit({ state: 'uploading' });
        await this.uploadLoop(startOffset);
      }
    } catch (err: unknown) {
      if (this.isPaused || this.isAborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;

      if (!this.isPaused && !this.isAborted && !this.terminalReconciliationAttempted && this.isNetworkOrStatus0Error(err)) {
        this.terminalReconciliationAttempted = true;
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
          if (this.isTerminalError(reconErr)) {
            this.clearStorage();
          }
          throw cleanReconErr;
        }
      }

      const cleanErr = redactError(err);
      this.emit({ state: 'failed', error: cleanErr.message });
      if (this.isTerminalError(err)) {
        this.clearStorage();
      }
      throw cleanErr;
    }
  }

  private isNetworkOrStatus0Error(err: unknown): boolean {
    if (err && typeof err === 'object' && 'message' in err) {
      const msg = (err as { message: string }).message;
      return (
        msg === 'GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED' ||
        msg === 'Network request failed' ||
        msg.includes('HTTP 0') ||
        msg.includes('code 0')
      );
    }
    if (err && typeof err === 'object' && 'status' in err && (err as Record<string, unknown>).status === 0) {
      return true;
    }
    return false;
  }

  private isTerminalError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return false;
    }
    if (err && typeof err === 'object') {
      if ('isTerminal' in err) {
        return !!(err as { isTerminal: boolean }).isTerminal;
      }
      if ('message' in err) {
        const msg = (err as { message: string }).message;
        if (
          msg === 'UPLOAD_SESSION_EXPIRED' ||
          msg === 'UPLOAD_SESSION_RESTART_REQUIRED' ||
          msg === 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE' ||
          msg === 'GOOGLE_DRIVE_INVALID_RESUME_RANGE' ||
          msg.includes('stalled') ||
          msg.includes('progress stalled') ||
          msg.includes('alignment') ||
          msg.includes('chunk alignment') ||
          err instanceof SyntaxError ||
          err instanceof TypeError
        ) {
          return true;
        }
        if (
          msg === 'Network request failed' ||
          msg === 'GOOGLE_DRIVE_UPLOAD_FAILED' ||
          msg === 'GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED' ||
          msg.includes('HTTP 0') ||
          msg.includes('code 0')
        ) {
          return false;
        }
      }
    }
    return false;
  }

  private async attemptServerReconciliation(): Promise<boolean> {
    if (this.isPaused || this.isAborted || this.isReconciling) {
      return false;
    }

    this.isReconciling = true;
    let response: Response;
    try {
      this.activeController = new AbortController();
      response = await fetch(`/api/uploads/${this.assetId}/reconcile`, {
        method: 'POST',
        signal: this.activeController.signal,
      });
    } catch (err: unknown) {
      this.isReconciling = false;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new GoogleDriveUploadError('Network request failed', false);
    }

    try {
      if (response.status === 404 || response.status === 410) {
        throw new GoogleDriveUploadError('UPLOAD_SESSION_EXPIRED', true);
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new GoogleDriveUploadError('UPLOAD_SESSION_RESTART_REQUIRED', true);
      }
      const isTransient = response.status === 429 ||
                          response.status === 500 ||
                          response.status === 502 ||
                          response.status === 503 ||
                          response.status === 504;
      if (isTransient) {
        throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
      }
      if (!response.ok) {
        throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', true);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new GoogleDriveUploadError('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE', true);
      }

      if (!isRecord(data) || typeof data.status !== 'string') {
        throw new GoogleDriveUploadError('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE', true);
      }

      const serverStatus = data.status;
      if (serverStatus === 'VALIDATING') {
        this.triggerValidateAndPoll();
        return true;
      } else if (serverStatus === 'VALIDATED') {
        let checkResponse: Response;
        try {
          checkResponse = await fetch(`/api/uploads/${this.assetId}`, {
            signal: this.activeController.signal,
          });
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          throw new GoogleDriveUploadError('Network request failed', false);
        }

        if (checkResponse.status === 404 || checkResponse.status === 410) {
          throw new GoogleDriveUploadError('UPLOAD_SESSION_EXPIRED', true);
        }
        if (checkResponse.status >= 400 && checkResponse.status < 500 && checkResponse.status !== 429) {
          throw new GoogleDriveUploadError('UPLOAD_SESSION_RESTART_REQUIRED', true);
        }
        const isCheckTransient = checkResponse.status === 429 ||
                                checkResponse.status === 500 ||
                                checkResponse.status === 502 ||
                                checkResponse.status === 503 ||
                                checkResponse.status === 504;
        if (isCheckTransient) {
          throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
        }
        if (!checkResponse.ok) {
          throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', true);
        }

        let checkData: unknown;
        try {
          checkData = await checkResponse.json();
        } catch {
          throw new GoogleDriveUploadError('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE', true);
        }

        let parsed: ReturnType<typeof parseValidationStatus>;
        try {
          parsed = parseValidationStatus(checkData);
        } catch {
          throw new GoogleDriveUploadError('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE', true);
        }

        if (parsed.status === 'VALIDATED') {
          const metadata: MediaMetadata = {
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
        throw new GoogleDriveUploadError('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE', true);
      } else if (serverStatus === 'UPLOADING') {
        const confirmedBytes = typeof data.confirmedBytes === 'number' ? data.confirmedBytes : 0;
        if (confirmedBytes > this.uploadedBytes) {
          this.uploadedBytes = confirmedBytes;
        }
        return false;
      }
      throw new GoogleDriveUploadError('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE', true);
    } finally {
      this.isReconciling = false;
    }
    return false;
  }

  public async querySessionStatus(): Promise<number> {
    if (this.sessionUri) {
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
        try {
          const range = response.headers.get('Range');
          return parseRangeHeader(range, this.file.size);
        } catch (err: unknown) {
          throw new GoogleDriveUploadError(
            err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
              ? (err as { message: string }).message
              : 'GOOGLE_DRIVE_INVALID_RESUME_RANGE',
            true
          );
        }
      }
      if (response.status === 200 || response.status === 201) {
        try {
          const parsed = JSON.parse(response.body);
          const driveFileId = parseDriveFileId(parsed);
          await this.triggerCompleteAPI(driveFileId);
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'isTerminal' in err) {
            throw err;
          }
          throw new GoogleDriveUploadError(
            err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
              ? (err as { message: string }).message
              : 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE',
            true
          );
        }
        return this.file.size;
      }
      if (response.status === 0) {
        throw new GoogleDriveUploadError('Network request failed', false);
      }
      if (response.status === 404 || response.status === 410) {
        throw new GoogleDriveUploadError('UPLOAD_SESSION_EXPIRED', true);
      }
      const isTransient = response.status === 429 ||
                          response.status === 500 ||
                          response.status === 502 ||
                          response.status === 503 ||
                          response.status === 504;
      if (isTransient) {
        this.lastRetryAfterMs = parseRetryAfterHeader(
          response.headers.get('Retry-After')
        );
        throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
      }
      if (response.status >= 400 && response.status < 500) {
        throw new GoogleDriveUploadError('UPLOAD_SESSION_RESTART_REQUIRED', true);
      }
      throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', true);
    }

    const response = await this.transport.send({
      method: 'POST',
      url: `/api/uploads/${this.assetId}/reconcile`,
      headers: {
        'Content-Length': '0',
      },
      body: null,
      signal: this.activeController?.signal,
    });

    if (response.status === 200 || response.status === 201) {
      try {
        const parsed: unknown = JSON.parse(response.body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
        }
        const data = parsed as { status?: string; confirmedBytes?: number };
        if (data.status === 'VALIDATED' || data.status === 'VALIDATING') {
          return this.file.size;
        }
        const confirmedBytes = data.confirmedBytes;
        if (typeof confirmedBytes === 'number') {
          return confirmedBytes;
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        const isTerm = err instanceof SyntaxError || err instanceof TypeError || (err instanceof Error && err.message === 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
        throw new GoogleDriveUploadError(
          err instanceof Error ? err.message : 'GOOGLE_DRIVE_UPLOAD_FAILED',
          isTerm
        );
      }
    }

    if (response.status === 0) {
      throw new GoogleDriveUploadError('Network request failed', false);
    }

    if (response.status === 404 || response.status === 410) {
      throw new GoogleDriveUploadError('UPLOAD_SESSION_EXPIRED', true);
    }

    const isTransient = response.status === 429 ||
                        response.status === 500 ||
                        response.status === 502 ||
                        response.status === 503 ||
                        response.status === 504;

    if (isTransient) {
      this.lastRetryAfterMs = parseRetryAfterHeader(
        response.headers.get('Retry-After')
      );
      throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
    }

    if (response.status >= 400 && response.status < 500) {
      throw new GoogleDriveUploadError('UPLOAD_SESSION_RESTART_REQUIRED', true);
    }

    throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', true);
  }

  private async querySessionStatusWithRetry(skipRetry = false): Promise<number> {
    let attempt = 0;
    const effectiveMaxRetries = skipRetry ? 0 : this.maxRetries;
    while (attempt <= effectiveMaxRetries) {
      if (this.isPaused || this.isAborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      try {
        this.activeController = new AbortController();
        if (attempt > 0) {
          this.emit({ state: 'retrying', retryAttempt: attempt });
          let backoffTime = this.retryBackoffMs * Math.pow(2, attempt - 1);
          if (this.lastRetryAfterMs !== null) {
            backoffTime = this.lastRetryAfterMs;
            this.lastRetryAfterMs = null;
          }
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
        if (this.isPaused || this.isAborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        if (err instanceof DOMException && err.name === 'AbortError') throw err;

        if (this.isTerminalError(err)) {
          throw err;
        }

        attempt++;
        if (attempt > effectiveMaxRetries) {
          throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED', false);
        }
      }
    }
    throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED', false);
  }

  private async uploadLoop(startOffset: number) {
    let offset = startOffset;

    while (offset < this.file.size) {
      if (this.isPaused || this.isAborted) return;

      const end = Math.min(offset + this.CHUNK_SIZE, this.file.size);
      const length = end - offset;

      if (end < this.file.size && length % (256 * 1024) !== 0) {
        throw new GoogleDriveUploadError('Invalid chunk size alignment: non-final chunks must be multiples of 256 KiB.', true);
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
            let backoffTime = this.retryBackoffMs * Math.pow(2, attempt - 1);
            if (this.lastRetryAfterMs !== null) {
              backoffTime = this.lastRetryAfterMs;
              this.lastRetryAfterMs = null;
            }
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

            const freshOffset = await this.querySessionStatusWithRetry(true);
            if (freshOffset >= this.file.size) {
              return;
            }
            offset = freshOffset;
            this.uploadedBytes = offset;
            this.emit({ state: 'uploading' });

            const retryEnd = Math.min(offset + this.CHUNK_SIZE, this.file.size);
            const retryLength = retryEnd - offset;
            if (retryEnd < this.file.size && retryLength % (256 * 1024) !== 0) {
              throw new GoogleDriveUploadError('Invalid chunk size alignment: non-final chunks must be multiples of 256 KiB.', true);
            }
            const retryChunk = this.file.slice(offset, retryEnd);

            await this.sendPut(offset, retryEnd, retryLength, retryChunk);
            success = true;
          } else {
            await this.sendPut(offset, end, length, chunk);
            success = true;
          }
        } catch (err: unknown) {
          if (this.isPaused || this.isAborted) return;
          if (err instanceof DOMException && err.name === 'AbortError') return;

          if (this.isTerminalError(err)) {
            throw err;
          }

          if (!this.isPaused && !this.isAborted && (this.immediateReconOffset === null || this.immediateReconOffset !== offset) && this.isNetworkOrStatus0Error(err)) {
            this.immediateReconOffset = offset;
            try {
              const reconciled = await this.attemptServerReconciliation();
              if (reconciled) {
                return;
              }
              offset = this.uploadedBytes;
            } catch (reconErr: unknown) {
              if (reconErr instanceof DOMException && reconErr.name === 'AbortError') {
                return;
              }
            }
          }

          attempt++;
          if (attempt > this.maxRetries) {
            throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_RETRY_EXHAUSTED', false);
          }
        }
      }

      const newOffset = this.uploadedBytes;
      if (newOffset === offset) {
        this.unchangedOffsetCount++;
        if (this.unchangedOffsetCount >= 3) {
          throw new GoogleDriveUploadError('Upload progress stalled: Google Drive returned an unchanged or backwards offset.', true);
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
      url: this.sessionUri || `/api/uploads/${this.assetId}/chunk`,
      headers: {
        'Content-Type': getUploadFileMimeType(this.file),
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
      try {
        const range = response.headers.get('Range');
        const parsedOffset = parseRangeHeader(range, this.file.size);
        this.uploadedBytes = parsedOffset;
        this.emit({
          state: 'uploading',
          uploadedBytes: parsedOffset,
        });
        return;
      } catch (err: unknown) {
        throw new GoogleDriveUploadError(
          err instanceof Error ? err.message : 'GOOGLE_DRIVE_INVALID_RESUME_RANGE',
          true
        );
      }
    }

    if (response.status === 200 || response.status === 201) {
      try {
        const parsed: unknown = JSON.parse(response.body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE');
        }

        const resData = parsed as { confirmedBytes?: number; completed?: boolean; status?: string; id?: unknown };
        const confirmedBytes = resData.confirmedBytes ?? start;
        this.uploadedBytes = confirmedBytes;

        if (resData.completed) {
          this.uploadedBytes = this.file.size;
          this.emit({
            state: 'uploading',
            uploadedBytes: this.file.size,
          });
          await this.triggerValidateAndPoll();
          return;
        } else if (this.sessionUri) {
          const driveFileId = parseDriveFileId(parsed);
          this.uploadedBytes = this.file.size;
          this.emit({
            state: 'uploading',
            uploadedBytes: this.file.size,
          });
          await this.triggerCompleteAPI(driveFileId);
          return;
        }

        this.emit({
          state: 'uploading',
          uploadedBytes: this.uploadedBytes,
        });
        return;
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        if (err instanceof GoogleDriveUploadError) {
          throw err;
        }
        const isTerm = !!(err instanceof SyntaxError || err instanceof TypeError || (err && typeof err === 'object' && 'message' in err && (err as { message: unknown }).message === 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE'));
        const errMsg = (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string')
          ? (err as { message: string }).message
          : 'GOOGLE_DRIVE_UPLOAD_FAILED';
        throw new GoogleDriveUploadError(
          errMsg,
          isTerm
        );
      }
    }

    if (response.status === 0) {
      throw new GoogleDriveUploadError('Network request failed', false);
    }

    if (response.status === 404 || response.status === 410) {
      throw new GoogleDriveUploadError('UPLOAD_SESSION_EXPIRED', true);
    }

    try {
      const parsed: unknown = JSON.parse(response.body);
      if (parsed && typeof parsed === 'object') {
        const data = parsed as { retryable?: boolean; error?: string };
        if (data.error === 'UPLOAD_SESSION_EXPIRED') {
          throw new GoogleDriveUploadError('UPLOAD_SESSION_EXPIRED', true);
        }
        if (data.error === 'UPLOAD_SESSION_RESTART_REQUIRED') {
          throw new GoogleDriveUploadError('UPLOAD_SESSION_RESTART_REQUIRED', true);
        }
        if (data.retryable) {
          throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
        }
      }
    } catch {
      // Ignore
    }

    const isTransient = response.status === 429 ||
                        response.status === 500 ||
                        response.status === 502 ||
                        response.status === 503 ||
                        response.status === 504;

    if (isTransient) {
      this.lastRetryAfterMs = parseRetryAfterHeader(
        response.headers.get('Retry-After')
      );
      throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
    }

    if (response.status >= 400 && response.status < 500) {
      throw new GoogleDriveUploadError('UPLOAD_SESSION_RESTART_REQUIRED', true);
    }

    throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', true);
  }

  private async triggerValidateAndPoll() {
    this.emit({ state: 'validating' });

    try {
      this.activeController = new AbortController();
      const response = await fetch(`/api/uploads/${this.assetId}/validate`, {
        method: 'POST',
        signal: this.activeController.signal,
      });

      if (this.isPaused || this.isAborted) return;

      if (response.ok) {
        const data: unknown = await response.json();
        const parsed = parseValidationStatus(data);
        if (parsed.status === 'VALIDATED') {
          this.clearStorage();
          const metadata: MediaMetadata = {
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
          return;
        } else if (parsed.status === 'FAILED') {
          const errorMsg = parsed.failureMessage || 'GOOGLE_DRIVE_UPLOAD_FAILED';
          this.emit({ state: 'failed', error: errorMsg });
          return;
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // temporary failure, fallback to polling
    }

    this.startValidationPolling();
  }

  private async triggerCompleteAPI(driveFileId: string) {
    this.emit({ state: 'completing' });
    let response: Response;
    try {
      this.activeController = new AbortController();
      response = await fetch(`/api/uploads/${this.assetId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ driveFileId }),
        signal: this.activeController.signal,
      });
    } catch (err: unknown) {
      console.error('triggerCompleteAPI fetch error:', err);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new GoogleDriveUploadError('Network request failed', false);
    }

    if (!response.ok) {
      try {
        const data: unknown = await response.json();
        if (data && typeof data === 'object') {
          const errMsg = (data as { error?: unknown }).error;
          if (typeof errMsg === 'string' && errMsg === 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE') {
            throw new GoogleDriveUploadError('GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE', true);
          }
        }
      } catch (err: unknown) {
        if (err instanceof GoogleDriveUploadError) throw err;
      }
    }

    if (response.status === 404 || response.status === 410) {
      throw new GoogleDriveUploadError('UPLOAD_SESSION_EXPIRED', true);
    }
    if (response.status === 429) {
      throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
    }
    const isTransientCompletion = response.status === 500 ||
                                  response.status === 502 ||
                                  response.status === 503 ||
                                  response.status === 504;
    if (isTransientCompletion) {
      throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', false);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new GoogleDriveUploadError('UPLOAD_SESSION_RESTART_REQUIRED', true);
    }
    if (!response.ok) {
      throw new GoogleDriveUploadError('GOOGLE_DRIVE_UPLOAD_FAILED', true);
    }

    await this.triggerValidateAndPoll();
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

          const metadata: MediaMetadata = {
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
    if (this.state !== 'uploading' && this.state !== 'retrying' && this.state !== 'initiating' && this.state !== 'validating' && this.state !== 'completing') return;
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
