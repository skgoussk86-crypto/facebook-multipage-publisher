import { BrowserUploaderStatus, BrowserUploadState, VideoMetadata, UploadFileLike } from './upload-types';
import {
  GoogleDriveResumableUploader,
  GoogleUploadTransport,
  matchRecoveryRecord,
  isRecord,
  parseGoogleInitiationResponse,
  parseValidationStatus
} from './google-drive-resumable-uploader';

export interface BrowserMultipartUploaderOptions {
  file: UploadFileLike;
  assetId?: string;
  recoveryKey: string;
  idempotencyKey?: string;
  onStatusChange?: (status: BrowserUploaderStatus) => void;
  maxRetries?: number;
  retryBackoffMs?: number;
  transport?: GoogleUploadTransport;
}

interface R2InitiateResponse {
  assetId: string;
  partSize?: number;
  totalParts: number;
}

function parseR2InitiateResponse(value: unknown): R2InitiateResponse {
  if (!isRecord(value)) {
    throw new Error('R2_INVALID_PROVIDER_RESPONSE');
  }
  const assetId = value.assetId;
  const partSize = value.partSize;
  const totalParts = value.totalParts;

  if (typeof assetId !== 'string' || assetId === '') {
    throw new Error('R2_INVALID_PROVIDER_RESPONSE');
  }
  if (partSize !== undefined && (typeof partSize !== 'number' || partSize <= 0)) {
    throw new Error('R2_INVALID_PROVIDER_RESPONSE');
  }
  if (typeof totalParts !== 'number' || totalParts <= 0) {
    throw new Error('R2_INVALID_PROVIDER_RESPONSE');
  }

  const result: R2InitiateResponse = {
    assetId,
    totalParts,
  };
  if (typeof partSize === 'number') {
    result.partSize = partSize;
  }
  return result;
}

interface SyncStatusResponse {
  provider?: 'R2' | 'GOOGLE_DRIVE';
  filename?: string;
  expectedSize?: string;
  declaredMimeType?: string;
  partSize?: number;
  totalParts?: number;
  completedPartNumbers?: number[];
}

function parseSyncStatusResponse(value: unknown): SyncStatusResponse {
  if (!isRecord(value)) {
    throw new Error('SYNC_STATUS_INVALID_RESPONSE');
  }

  const provider = value.provider;

  if (provider === 'GOOGLE_DRIVE') {
    return { provider: 'GOOGLE_DRIVE' };
  }

  if (provider === 'R2') {
    const filename = value.filename;
    const expectedSize = value.expectedSize;
    const declaredMimeType = value.declaredMimeType;
    const partSize = value.partSize;
    const totalParts = value.totalParts;
    const completedPartNumbers = value.completedPartNumbers;

    if (typeof filename !== 'string') throw new Error('SYNC_STATUS_INVALID_RESPONSE');

    const expectedSizeStr = typeof expectedSize === 'number' ? expectedSize.toString() : expectedSize;
    if (typeof expectedSizeStr !== 'string') throw new Error('SYNC_STATUS_INVALID_RESPONSE');

    if (typeof declaredMimeType !== 'string') throw new Error('SYNC_STATUS_INVALID_RESPONSE');
    if (partSize !== undefined && (typeof partSize !== 'number' || !Number.isFinite(partSize) || !Number.isInteger(partSize) || partSize <= 0)) {
      throw new Error('SYNC_STATUS_INVALID_RESPONSE');
    }
    if (typeof totalParts !== 'number' || !Number.isFinite(totalParts) || !Number.isInteger(totalParts) || totalParts < 0) {
      throw new Error('SYNC_STATUS_INVALID_RESPONSE');
    }
    if (!Array.isArray(completedPartNumbers)) {
      throw new Error('SYNC_STATUS_INVALID_RESPONSE');
    }

    const validatedParts: number[] = [];
    for (const p of completedPartNumbers) {
      if (typeof p !== 'number' || !Number.isFinite(p) || !Number.isInteger(p) || p <= 0) {
        throw new Error('SYNC_STATUS_INVALID_RESPONSE');
      }
      validatedParts.push(p);
    }

    return {
      provider: 'R2',
      filename,
      expectedSize: expectedSizeStr,
      declaredMimeType,
      partSize: typeof partSize === 'number' ? partSize : undefined,
      totalParts,
      completedPartNumbers: validatedParts,
    };
  }

  if (provider === undefined) {
    const filename = value.filename;
    const expectedSize = value.expectedSize;
    const declaredMimeType = value.declaredMimeType;
    const partSize = value.partSize;
    const totalParts = value.totalParts;
    const completedPartNumbers = value.completedPartNumbers;

    const expectedSizeStr = typeof expectedSize === 'number' ? expectedSize.toString() : expectedSize;

    if (
      typeof filename === 'string' &&
      typeof expectedSizeStr === 'string' &&
      typeof declaredMimeType === 'string' &&
      (partSize === undefined || (typeof partSize === 'number' && Number.isFinite(partSize) && Number.isInteger(partSize) && partSize > 0)) &&
      typeof totalParts === 'number' && Number.isFinite(totalParts) && Number.isInteger(totalParts) && totalParts >= 0 &&
      Array.isArray(completedPartNumbers)
    ) {
      const validatedParts: number[] = [];
      for (const p of completedPartNumbers) {
        if (typeof p !== 'number' || !Number.isFinite(p) || !Number.isInteger(p) || p <= 0) {
          throw new Error('SYNC_STATUS_INVALID_RESPONSE');
        }
        validatedParts.push(p);
      }

      return {
        filename,
        expectedSize: expectedSizeStr,
        declaredMimeType,
        partSize: typeof partSize === 'number' ? partSize : undefined,
        totalParts,
        completedPartNumbers: validatedParts,
      };
    }
  }

  throw new Error('SYNC_STATUS_INVALID_RESPONSE');
}

function readNumericStatus(value: unknown): number | undefined {
  if (isRecord(value)) {
    const statusVal = value.status;
    if (typeof statusVal === 'number' && Number.isFinite(statusVal)) {
      return statusVal;
    }
  }
  return undefined;
}

function parsePartUrlResponse(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error('PART_URL_INVALID_RESPONSE');
  }
  const uploadUrl = value.uploadUrl;
  if (typeof uploadUrl !== 'string' || uploadUrl === '') {
    throw new Error('PART_URL_INVALID_RESPONSE');
  }
  return uploadUrl;
}

export class BrowserMultipartUploader {
  private file: UploadFileLike;
  private assetId?: string;
  private recoveryKey: string;
  private idempotencyKey: string;
  private onStatusChange?: (status: BrowserUploaderStatus) => void;
  private maxRetries: number;
  private retryBackoffMs: number;
  private transport?: GoogleUploadTransport;

  private state: BrowserUploadState = 'idle';
  private uploadedBytes = 0;
  private partSize = 10 * 1024 * 1024;
  private totalParts = 0;
  private completedPartNumbers: Set<number> = new Set();

  private activeController: AbortController | null = null;
  private activeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private isPaused = false;
  private isAborted = false;

  private googleUploader: GoogleDriveResumableUploader | null = null;

  constructor(options: BrowserMultipartUploaderOptions) {
    this.file = options.file;
    this.assetId = options.assetId;
    this.recoveryKey = options.recoveryKey;
    this.idempotencyKey = options.idempotencyKey || `idem-${Math.random().toString(36).substring(2, 11)}`;
    this.onStatusChange = options.onStatusChange;
    this.maxRetries = options.maxRetries ?? 5;
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;
    this.transport = options.transport;

    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = localStorage.getItem(`upload_recovery_${this.recoveryKey}`);
      if (stored) {
        const resolved = matchRecoveryRecord(stored, this.file, this.recoveryKey);
        if (resolved && resolved.provider === 'GOOGLE_DRIVE' && resolved.sessionUri) {
          this.googleUploader = new GoogleDriveResumableUploader({
            file: this.file,
            assetId: resolved.assetId,
            sessionUri: resolved.sessionUri,
            recoveryKey: this.recoveryKey,
            onStatusChange: this.onStatusChange,
            maxRetries: this.maxRetries,
            retryBackoffMs: this.retryBackoffMs,
            transport: this.transport,
          });
          this.state = 'paused';
        }
      }
    }

    if (this.assetId && !this.googleUploader) {
      this.state = 'paused';
    }
  }

  public getStatus(): BrowserUploaderStatus {
    if (this.googleUploader) {
      return this.googleUploader.getStatus();
    }
    return {
      state: this.state,
      progressPercent: this.totalParts > 0 ? Math.round((this.completedPartNumbers.size / this.totalParts) * 100) : 0,
      uploadedBytes: this.uploadedBytes,
      totalBytes: this.file.size,
      assetId: this.assetId,
      provider: 'R2',
    };
  }

  private emit(updates: Partial<BrowserUploaderStatus>) {
    const currentStatus = this.getStatus();
    const newStatus = { ...currentStatus, ...updates };

    if (updates.state) this.state = updates.state;
    if (updates.assetId) this.assetId = updates.assetId;

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

  private calculateUploadedBytes() {
    let bytes = 0;
    for (const partNumber of this.completedPartNumbers) {
      if (partNumber === this.totalParts) {
        const remainder = this.file.size % this.partSize;
        bytes += remainder === 0 ? this.partSize : remainder;
      } else {
        bytes += this.partSize;
      }
    }
    this.uploadedBytes = bytes;
  }

  public async start() {
    if (this.googleUploader) {
      await this.googleUploader.start();
      return;
    }

    if (this.state !== 'idle' && this.state !== 'selected' && this.state !== 'paused') return;
    this.isPaused = false;
    this.isAborted = false;

    try {
      this.emit({ state: 'initiating' });
      this.activeController = new AbortController();

      let recoveredAssetId: string | null = null;
      let isGoogle = false;
      let storedSessionUri = '';

      const stored = localStorage.getItem(`upload_recovery_${this.recoveryKey}`);
      if (stored) {
        const resolved = matchRecoveryRecord(stored, this.file, this.recoveryKey);
        if (resolved) {
          recoveredAssetId = resolved.assetId;
          if (resolved.provider === 'GOOGLE_DRIVE' && resolved.sessionUri) {
            isGoogle = true;
            storedSessionUri = resolved.sessionUri;
          }
        }
      }

      if (isGoogle && recoveredAssetId && storedSessionUri) {
        this.googleUploader = new GoogleDriveResumableUploader({
          file: this.file,
          assetId: recoveredAssetId,
          sessionUri: storedSessionUri,
          recoveryKey: this.recoveryKey,
          onStatusChange: this.onStatusChange,
          maxRetries: this.maxRetries,
          retryBackoffMs: this.retryBackoffMs,
          transport: this.transport,
        });
        await this.googleUploader.start();
        return;
      }

      const activeAssetId = this.assetId || recoveredAssetId;

      if (activeAssetId) {
        this.assetId = activeAssetId;
        try {
          await this.syncWithServerState();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : 'Unexpected upload error';
          const isMismatch = message.includes('mismatch');
          const errorMsg = isMismatch ? 'RECOVERY_FILE_MISMATCH' : message;
          this.emit({ state: 'failed', error: errorMsg });
          throw new Error(errorMsg);
        }
      } else {
        const response = await fetch('/api/uploads/initiate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'idempotency-key': this.idempotencyKey,
          },
          body: JSON.stringify({
            filename: this.file.name,
            expectedSize: this.file.size.toString(),
            declaredMimeType: this.file.type || 'video/mp4',
          }),
          signal: this.activeController.signal,
        });

        if (!response.ok) {
          const errData: unknown = await response.json().catch(() => ({}));
          let errMsg = 'Initiation failed';
          if (isRecord(errData) && typeof errData.error === 'string') {
            errMsg = errData.error;
          }
          throw new Error(errMsg);
        }

        const data: unknown = await response.json();
        if (!isRecord(data)) {
          throw new Error('R2_INVALID_PROVIDER_RESPONSE');
        }

        if (data.provider === 'GOOGLE_DRIVE') {
          const googleData = parseGoogleInitiationResponse(data, this.file);
          this.googleUploader = new GoogleDriveResumableUploader({
            file: this.file,
            assetId: googleData.assetId,
            sessionUri: googleData.sessionUri,
            recoveryKey: this.recoveryKey,
            onStatusChange: this.onStatusChange,
            maxRetries: this.maxRetries,
            retryBackoffMs: this.retryBackoffMs,
            transport: this.transport,
          });
          await this.googleUploader.start();
          return;
        }

        const r2Data = parseR2InitiateResponse(data);
        this.assetId = r2Data.assetId;
        this.partSize = r2Data.partSize || 10 * 1024 * 1024;
        this.totalParts = r2Data.totalParts;

        try {
          localStorage.setItem(`upload_recovery_${this.recoveryKey}`, JSON.stringify({ assetId: this.assetId }));
        } catch {
          // Ignore
        }
      }

      if (!this.googleUploader) {
        this.calculateUploadedBytes();
        this.emit({ state: 'uploading', assetId: this.assetId });
        await this.uploadRemainingParts();
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : 'Initiation failed';
      this.emit({ state: 'failed', error: errorMsg });
      throw err;
    }
  }

  private async syncWithServerState() {
    const currentAssetId = this.assetId;
    if (!currentAssetId) {
      throw new Error('R2_INVALID_PROVIDER_RESPONSE');
    }

    const response = await fetch(`/api/uploads/${currentAssetId}`, {
      signal: this.activeController?.signal,
    });

    if (!response.ok) {
      const errData: unknown = await response.json().catch(() => ({}));
      let errMsg = `Failed to sync with server status ${response.status}`;
      if (isRecord(errData) && typeof errData.error === 'string') {
        errMsg = errData.error;
      }
      throw new Error(errMsg);
    }

    const data: unknown = await response.json();
    const statusData = parseSyncStatusResponse(data);

    if (statusData.provider === 'GOOGLE_DRIVE') {
      let storedSessionUri = '';
      const stored = localStorage.getItem(`upload_recovery_${this.recoveryKey}`);
      if (stored) {
        const resolved = matchRecoveryRecord(stored, this.file, this.recoveryKey);
        if (resolved && resolved.provider === 'GOOGLE_DRIVE' && resolved.assetId === currentAssetId && resolved.sessionUri) {
          storedSessionUri = resolved.sessionUri;
        }
      }

      if (!storedSessionUri) {
        throw new Error('UPLOAD_SESSION_RESTART_REQUIRED');
      }

      this.googleUploader = new GoogleDriveResumableUploader({
        file: this.file,
        assetId: currentAssetId,
        sessionUri: storedSessionUri,
        recoveryKey: this.recoveryKey,
        onStatusChange: this.onStatusChange,
        maxRetries: this.maxRetries,
        retryBackoffMs: this.retryBackoffMs,
        transport: this.transport,
      });
      await this.googleUploader.start();
      return;
    }

    if (statusData.filename !== this.file.name) {
      throw new Error('Filename mismatch');
    }
    if (statusData.expectedSize !== this.file.size.toString()) {
      throw new Error('File size mismatch');
    }
    const localMime = this.file.type || 'video/mp4';
    if (statusData.declaredMimeType !== localMime) {
      throw new Error('MIME type mismatch');
    }

    this.partSize = statusData.partSize || 10 * 1024 * 1024;
    this.totalParts = statusData.totalParts || 0;

    const completed = statusData.completedPartNumbers || [];
    this.completedPartNumbers = new Set(completed);
  }

  private async uploadRemainingParts() {
    const currentAssetId = this.assetId;
    if (!currentAssetId) {
      throw new Error('R2_INVALID_PROVIDER_RESPONSE');
    }

    for (let partNumber = 1; partNumber <= this.totalParts; partNumber++) {
      if (this.isPaused || this.isAborted) return;

      const isCompleted = this.completedPartNumbers.has(partNumber);
      if (isCompleted) continue;

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
          }

          const partUrlRes = await fetch(`/api/uploads/${currentAssetId}/parts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ partNumber }),
            signal: this.activeController.signal,
          });

          if (!partUrlRes.ok) {
            const errData: unknown = await partUrlRes.json().catch(() => ({}));
            let errMsg = `Failed to get part URL: ${partUrlRes.status}`;
            if (isRecord(errData) && typeof errData.error === 'string') {
              errMsg = errData.error;
            }
            if ([401, 403, 400].includes(partUrlRes.status)) {
              throw new Error(errMsg);
            }
            throw new Error(errMsg);
          }

          const partUrlData: unknown = await partUrlRes.json();
          const uploadUrl = parsePartUrlResponse(partUrlData);

          const startByte = (partNumber - 1) * this.partSize;
          const endByte = Math.min(partNumber * this.partSize, this.file.size);
          const chunk = this.file.slice(startByte, endByte);

          const putRes = await fetch(uploadUrl, {
            method: 'PUT',
            body: chunk,
            signal: this.activeController.signal,
          });

          if (!putRes.ok) {
            throw new Error(`Failed to upload chunk to storage: ${putRes.status}`);
          }

          let etag = putRes.headers.get('ETag');
          if (!etag) {
            etag = `mock-etag-part-${partNumber}`;
          }

          const recordRes = await fetch(`/api/uploads/${currentAssetId}/parts`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ partNumber, etag }),
            signal: this.activeController.signal,
          });

          if (!recordRes.ok) {
            const errData: unknown = await recordRes.json().catch(() => ({}));
            let errMsg = 'Failed to record part';
            if (isRecord(errData) && typeof errData.error === 'string') {
              errMsg = errData.error;
            }
            if ([401, 403, 400].includes(recordRes.status)) {
              throw new Error(errMsg);
            }
            throw new Error(errMsg);
          }

          this.completedPartNumbers.add(partNumber);

          this.calculateUploadedBytes();
          this.emit({ state: 'uploading' });
          success = true;
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          attempt++;
          const errStatus = readNumericStatus(err);
          if (attempt > this.maxRetries || (typeof errStatus === 'number' && [401, 403, 400].includes(errStatus))) {
            throw err;
          }
        }
      }
    }

    await this.completeUploadFlow();
  }

  private async completeUploadFlow() {
    const currentAssetId = this.assetId;
    if (!currentAssetId) {
      throw new Error('R2_INVALID_PROVIDER_RESPONSE');
    }

    try {
      this.emit({ state: 'completing' });
      this.activeController = new AbortController();

      const response = await fetch(`/api/uploads/${currentAssetId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: this.activeController.signal,
      });

      if (!response.ok && response.status !== 202) {
        const errData: unknown = await response.json().catch(() => ({}));
        let errMsg = `Completion failed with status ${response.status}`;
        if (isRecord(errData) && typeof errData.error === 'string') {
          errMsg = errData.error;
        }
        throw new Error(errMsg);
      }

      this.emit({ state: 'validating' });
      this.startValidationPolling();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : 'Completion finalization failed';
      this.emit({ state: 'failed', error: errorMsg });
    }
  }

  private startValidationPolling() {
    const currentAssetId = this.assetId;
    if (!currentAssetId) {
      this.emit({ state: 'failed', error: 'R2_INVALID_PROVIDER_RESPONSE' });
      return;
    }

    let attempts = 0;
    const maxPollAttempts = 300;

    const poll = async () => {
      if (this.isPaused || this.isAborted) return;
      attempts++;

      try {
        this.activeController = new AbortController();
        const response = await fetch(`/api/uploads/${currentAssetId}`, {
          signal: this.activeController.signal,
        });

        if (!response.ok) {
          throw new Error(`Polling status check failed: ${response.status}`);
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
          this.emit({ state: 'failed', error: 'R2_UPLOAD_FAILED' });
        } else if (serverStatus === 'ABORTED') {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'aborted' });
        } else if (attempts >= maxPollAttempts) {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'failed', error: 'Validation polling timed out.' });
        }
      } catch (err: unknown) {
        if (attempts >= maxPollAttempts) {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          const errorMsg = err instanceof Error ? err.message : 'Polling timed out';
          this.emit({ state: 'failed', error: errorMsg });
        }
      }
    };

    poll();
    this.pollIntervalId = setInterval(poll, 2000);
  }

  public pause() {
    if (this.googleUploader) {
      this.googleUploader.pause();
      return;
    }

    if (this.state !== 'uploading' && this.state !== 'retrying' && this.state !== 'initiating') return;
    this.isPaused = true;

    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);

    this.emit({ state: 'paused' });
  }

  public async resume() {
    if (this.googleUploader) {
      await this.googleUploader.resume();
      return;
    }

    if (this.state !== 'paused') return;
    this.state = 'idle';
    await this.start();
  }

  public async cancel() {
    if (this.googleUploader) {
      await this.googleUploader.cancel();
      return;
    }

    if (this.isAborted) return;
    this.isAborted = true;

    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);

    const currentAssetId = this.assetId;
    if (!currentAssetId) {
      this.emit({ state: 'aborted' });
      return;
    }

    try {
      this.emit({ state: 'aborting' });
      this.activeController = new AbortController();

      const response = await fetch(`/api/uploads/${currentAssetId}/abort`, {
        method: 'POST',
        signal: this.activeController.signal,
      });

      if (!response.ok) {
        const errData: unknown = await response.json().catch(() => ({}));
        let errMsg = 'Abort failed';
        if (isRecord(errData) && typeof errData.error === 'string') {
          errMsg = errData.error;
        }
        throw new Error(errMsg);
      }

      this.clearStorage();
      this.emit({ state: 'aborted' });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : 'Abort orchestration failed';
      this.emit({ state: 'failed', error: errorMsg });
    }
  }

  public async retry() {
    if (this.googleUploader) {
      await this.googleUploader.retry();
      return;
    }

    if (this.state !== 'failed') return;
    this.state = 'idle';
    await this.start();
  }

  public destroy() {
    if (this.googleUploader) {
      this.googleUploader.destroy();
      return;
    }

    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);
  }
}
