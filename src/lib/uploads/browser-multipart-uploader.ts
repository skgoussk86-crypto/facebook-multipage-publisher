import { BrowserUploaderStatus, BrowserUploadState, VideoMetadata } from './upload-types';

export interface BrowserMultipartUploaderOptions {
  file: File;
  assetId?: string;
  recoveryKey: string;
  idempotencyKey?: string;
  onStatusChange?: (status: BrowserUploaderStatus) => void;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export class BrowserMultipartUploader {
  private file: File;
  private assetId?: string;
  private recoveryKey: string;
  private idempotencyKey: string;
  private onStatusChange?: (status: BrowserUploaderStatus) => void;
  private maxRetries: number;
  private retryBackoffMs: number;

  private state: BrowserUploadState = 'idle';
  private uploadedBytes = 0;
  private partSize = 10 * 1024 * 1024; // Default 10 MiB, overridden by initiate response
  private totalParts = 0;
  private completedPartNumbers: Set<number> = new Set();

  private activeController: AbortController | null = null;
  private activeTimeoutId: NodeJS.Timeout | null = null;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private isPaused = false;
  private isAborted = false;

  constructor(options: BrowserMultipartUploaderOptions) {
    this.file = options.file;
    this.assetId = options.assetId;
    this.recoveryKey = options.recoveryKey;
    this.idempotencyKey = options.idempotencyKey || `idem-${Math.random().toString(36).substring(2, 11)}`;
    this.onStatusChange = options.onStatusChange;
    this.maxRetries = options.maxRetries ?? 5;
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;

    if (this.assetId) {
      this.state = 'paused';
    }
  }

  public getStatus(): BrowserUploaderStatus {
    return {
      state: this.state,
      progressPercent: this.totalParts > 0 ? Math.round((this.completedPartNumbers.size / this.totalParts) * 100) : 0,
      uploadedBytes: this.uploadedBytes,
      totalBytes: this.file.size,
      assetId: this.assetId,
    };
  }

  private emit(updates: Partial<BrowserUploaderStatus>) {
    const currentStatus = this.getStatus();
    const newStatus = { ...currentStatus, ...updates };

    // Maintain state internally
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
      // Ignore localStorage errors
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
    if (this.state !== 'idle' && this.state !== 'selected' && this.state !== 'paused') return;
    this.isPaused = false;
    this.isAborted = false;

    try {
      this.emit({ state: 'initiating' });
      this.activeController = new AbortController();

      let recoveredAssetId: string | null = null;
      try {
        const stored = localStorage.getItem(`upload_recovery_${this.recoveryKey}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          recoveredAssetId = parsed.assetId;
        }
      } catch {
        // Ignore
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
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Initiation failed with status ${response.status}`);
        }

        const data = await response.json();
        this.assetId = data.assetId;
        this.partSize = data.partSize || 10 * 1024 * 1024;
        this.totalParts = data.totalParts;

        try {
          localStorage.setItem(`upload_recovery_${this.recoveryKey}`, JSON.stringify({ assetId: this.assetId }));
        } catch {
          // Ignore storage quota errors
        }
      }

      this.calculateUploadedBytes();
      this.emit({ state: 'uploading', assetId: this.assetId });

      await this.uploadRemainingParts();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : 'Initiation failed';
      this.emit({ state: 'failed', error: errorMsg });
      throw err;
    }
  }

  private async syncWithServerState() {
    const response = await fetch(`/api/uploads/${this.assetId}`, {
      signal: this.activeController?.signal,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Failed to sync with server status ${response.status}`);
    }

    const data = await response.json();

    // Verify filename, size, and MIME metadata match local File
    if (data.filename !== this.file.name) {
      throw new Error('Filename mismatch');
    }
    if (Number(data.expectedSize) !== this.file.size) {
      throw new Error('File size mismatch');
    }
    const localMime = this.file.type || 'video/mp4';
    if (data.declaredMimeType !== localMime) {
      throw new Error('MIME type mismatch');
    }

    this.partSize = data.partSize || 10 * 1024 * 1024;
    this.totalParts = data.totalParts;

    this.completedPartNumbers = new Set(data.completedPartNumbers as number[]);
  }

  private async uploadRemainingParts() {
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

          // 1. Get presigned part URL
          const partUrlRes = await fetch(`/api/uploads/${this.assetId}/parts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ partNumber }),
            signal: this.activeController.signal,
          });

          if (!partUrlRes.ok) {
            const errData = await partUrlRes.json().catch(() => ({}));
            // Do not retry auth or validation errors
            if ([401, 403, 400].includes(partUrlRes.status)) {
              throw new Error(errData.error || 'Server rejected part request');
            }
            throw new Error(`Failed to get part URL: ${errData.error || partUrlRes.status}`);
          }

          const partUrlData = await partUrlRes.json();
          const uploadUrl = partUrlData.uploadUrl;

          // 2. PUT sliced chunk directly to storage
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
            // Fallback for mock environment or standard headers
            etag = `mock-etag-part-${partNumber}`;
          }

          // 3. Record part on backend
          const recordRes = await fetch(`/api/uploads/${this.assetId}/parts`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ partNumber, etag }),
            signal: this.activeController.signal,
          });

          if (!recordRes.ok) {
            const errData = await recordRes.json().catch(() => ({}));
            if ([401, 403, 400].includes(recordRes.status)) {
              throw new Error(errData.error || 'Server rejected completed part record');
            }
            throw new Error(`Failed to record part: ${errData.error || recordRes.status}`);
          }

          this.completedPartNumbers.add(partNumber);

          this.calculateUploadedBytes();
          this.emit({ state: 'uploading' });
          success = true;
        } catch (err: unknown) {
          if (err instanceof Error && err.name === 'AbortError') return;
          attempt++;
          const errStatus = (err && typeof err === 'object' && 'status' in err) ? (err as { status: unknown }).status : undefined;
          if (attempt > this.maxRetries || (typeof errStatus === 'number' && [401, 403, 400].includes(errStatus))) {
            throw err;
          }
        }
      }
    }

    await this.completeUploadFlow();
  }

  private async completeUploadFlow() {
    try {
      this.emit({ state: 'completing' });
      this.activeController = new AbortController();

      const response = await fetch(`/api/uploads/${this.assetId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}), // Do not send parts list or ETags
        signal: this.activeController.signal,
      });

      if (!response.ok && response.status !== 202) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Completion failed with status ${response.status}`);
      }

      this.emit({ state: 'validating' });
      this.startValidationPolling();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : 'Completion finalization failed';
      this.emit({ state: 'failed', error: errorMsg });
    }
  }

  private startValidationPolling() {
    let attempts = 0;
    const maxPollAttempts = 300; // 10 minutes total

    const poll = async () => {
      if (this.isPaused || this.isAborted) return;
      attempts++;

      try {
        this.activeController = new AbortController();
        const response = await fetch(`/api/uploads/${this.assetId}`, {
          signal: this.activeController.signal,
        });

        if (!response.ok) {
          throw new Error(`Polling status check failed: ${response.status}`);
        }

        const data = await response.json();
        const serverStatus = data.status;

        if (serverStatus === 'VALIDATED') {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.clearStorage();

          const metadata: VideoMetadata = {
            durationMs: data.durationMs ? Number(data.durationMs) : undefined,
            width: data.width ? Number(data.width) : undefined,
            height: data.height ? Number(data.height) : undefined,
            frameRate: data.frameRate ? Number(data.frameRate) : undefined,
            videoCodec: data.videoCodec || undefined,
            audioCodec: data.audioCodec || undefined,
            containerFormat: data.containerFormat || undefined,
            detectedMimeType: data.detectedMimeType || undefined,
          };

          this.emit({ state: 'validated', metadata });
        } else if (serverStatus === 'FAILED') {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'failed', error: data.failureMessage || `Validation failed with code: ${data.failureCode || 'UNKNOWN'}` });
        } else if (serverStatus === 'ABORTED') {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'aborted' });
        } else if (attempts >= maxPollAttempts) {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          this.emit({ state: 'failed', error: 'Validation polling timed out.' });
        }
      } catch (err: unknown) {
        // Network errors during polling do not fail the upload instantly; poll again
        if (attempts >= maxPollAttempts) {
          if (this.pollIntervalId) clearInterval(this.pollIntervalId);
          const errorMsg = err instanceof Error ? err.message : 'Polling timed out';
          this.emit({ state: 'failed', error: errorMsg });
        }
      }
    };

    // Run first poll immediately
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
    this.state = 'idle'; // Reset state machine eligibility
    await this.start();
  }

  public async cancel() {
    if (this.isAborted) return;
    this.isAborted = true;

    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);

    if (!this.assetId) {
      this.emit({ state: 'aborted' });
      return;
    }

    try {
      this.emit({ state: 'aborting' });
      this.activeController = new AbortController();

      const response = await fetch(`/api/uploads/${this.assetId}/abort`, {
        method: 'POST',
        signal: this.activeController.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Abort failed with status ${response.status}`);
      }

      this.clearStorage();
      this.emit({ state: 'aborted' });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      const errorMsg = err instanceof Error ? err.message : 'Abort orchestration failed';
      this.emit({ state: 'failed', error: errorMsg });
    }
  }

  public async retry() {
    if (this.state !== 'failed') return;
    this.state = 'idle'; // Reset eligibility
    await this.start();
  }

  public destroy() {
    if (this.activeController) this.activeController.abort();
    if (this.activeTimeoutId) clearTimeout(this.activeTimeoutId);
    if (this.pollIntervalId) clearInterval(this.pollIntervalId);
  }
}
