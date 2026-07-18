import { BrowserMultipartUploader } from './browser-multipart-uploader';
import { BrowserUploaderStatus, VideoMetadata } from './upload-types';
import { GoogleUploadTransport } from './google-drive-resumable-uploader';

export type QueueItemState =
  | 'QUEUED'
  | 'INITIATING'
  | 'UPLOADING'
  | 'PAUSED'
  | 'RECONCILING'
  | 'COMPLETING'
  | 'VALIDATING'
  | 'VALIDATED'
  | 'RETRY_WAIT'
  | 'NEEDS_FILE_RESELECTION'
  | 'FAILED'
  | 'CANCELLED';

export interface QueueItem {
  id: string; // Stable queue item ID (based on file fingerprint or restored unique key)
  fingerprint: string; // Stable fingerprint based on: name, size, type, lastModified
  filename: string;
  size: number;
  type: string;
  lastModified: number;
  status: QueueItemState;
  progressPercent: number;
  uploadedBytes: number;
  assetId?: string;
  error?: string;
  retryAttempt?: number;
  metadata?: VideoMetadata;
  provider?: 'R2' | 'GOOGLE_DRIVE';
  idempotencyKey: string;
  timestamp: number;
  file?: File;

  // Job metadata fields
  pageId: string;
  contentType: 'VIDEO' | 'REEL';
  englishTitle: string;
  englishCaption: string;
  hashtags: string;
  scheduledTimeKolkata: string;
  scheduledTimeUTC: string;
  thumbnailMode: 'auto' | 'custom' | 'captured';
  customThumbnailUrl?: string;
  capturedThumbnailUrl?: string;
  localVideoUrl?: string;
  durationSeconds?: number;
}

export function getFileFingerprint(file: { name: string; size: number; type: string; lastModified: number }): string {
  return `fp-${file.name}-${file.size}-${file.type || 'video/mp4'}-${file.lastModified}`;
}

export interface UploadQueueControllerOptions {
  maxConcurrency?: number;
  storageKey?: string;
  onChange?: (items: QueueItem[]) => void;
  onUploadValidated?: (itemId: string, assetId: string, metadata: VideoMetadata) => void;
  transport?: GoogleUploadTransport;
}

export class UploadQueueController {
  private items: QueueItem[] = [];
  private uploaders: Map<string, BrowserMultipartUploader> = new Map();
  private maxConcurrency = 2;
  private storageKey = 'fb_publisher_upload_queue_v3';
  private onChange?: (items: QueueItem[]) => void;
  private onUploadValidated?: (itemId: string, assetId: string, metadata: VideoMetadata) => void;
  private transport?: GoogleUploadTransport;

  constructor(options?: UploadQueueControllerOptions) {
    if (options?.maxConcurrency !== undefined) {
      this.maxConcurrency = options.maxConcurrency;
    }
    if (options?.storageKey) {
      this.storageKey = options.storageKey;
    }
    this.onChange = options?.onChange;
    this.onUploadValidated = options?.onUploadValidated;
    this.transport = options?.transport;

    this.scrubLegacyStorageRecords();
    this.loadFromStorage();
  }

  private scrubLegacyStorageRecords() {
    if (typeof localStorage === 'undefined') return;

    try {
      const keysToScrub: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('upload_recovery_')) {
          keysToScrub.push(key);
        }
      }

      for (const key of keysToScrub) {
        const value = localStorage.getItem(key);
        if (value) {
          try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
              if (parsed.sessionUri || parsed.version === 2) {
                if (parsed.provider === 'GOOGLE_DRIVE') {
                  const sanitizedRecord = {
                    version: 3,
                    provider: 'GOOGLE_DRIVE',
                    assetId: parsed.assetId,
                    filename: parsed.filename,
                    mimeType: parsed.mimeType,
                    totalBytes: parsed.totalBytes,
                    lastModified: parsed.lastModified,
                  };
                  localStorage.setItem(key, JSON.stringify(sanitizedRecord));
                } else {
                  localStorage.removeItem(key);
                }
              }
            }
          } catch {
            localStorage.removeItem(key);
          }
        }
      }
    } catch {
      // Avoid throwing in restricted environments
    }
  }

  public getItems(): QueueItem[] {
    return [...this.items];
  }

  private notify() {
    if (this.onChange) {
      this.onChange(this.getItems());
    }
  }

  private loadFromStorage() {
    if (typeof localStorage === 'undefined') return;

    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      // Schema and version validation
      if (parsed.version !== 3 || !Array.isArray(parsed.items)) {
        // Safe reset for older/malformed schema version
        return;
      }

      const restoredItems: QueueItem[] = [];
      const now = Date.now();

      for (const item of parsed.items) {
        // Safe parsing and type validation
        if (
          typeof item.id !== 'string' ||
          typeof item.fingerprint !== 'string' ||
          typeof item.filename !== 'string' ||
          typeof item.size !== 'number' ||
          typeof item.lastModified !== 'number' ||
          typeof item.idempotencyKey !== 'string'
        ) {
          continue; // skip malformed item
        }

        // Cleanup of terminal items older than 24 hours
        const isTerminal = ['VALIDATED', 'FAILED', 'CANCELLED'].includes(item.status);
        const ageMs = now - (item.timestamp || now);
        if (isTerminal && ageMs > 24 * 60 * 60 * 1000) {
          continue; // cleanup older terminal item
        }

        // Initialize state on recovery:
        // If it's already VALIDATED, keep it. Otherwise, if it has no file object,
        // we must mark it as NEEDS_FILE_RESELECTION.
        let status: QueueItemState = item.status;
        if (status !== 'VALIDATED') {
          status = 'NEEDS_FILE_RESELECTION';
        }

        restoredItems.push({
          id: item.id,
          fingerprint: item.fingerprint,
          filename: item.filename,
          size: item.size,
          type: item.type || '',
          lastModified: item.lastModified,
          status,
          progressPercent: item.progressPercent || 0,
          uploadedBytes: item.uploadedBytes || 0,
          assetId: item.assetId,
          error: item.error,
          retryAttempt: item.retryAttempt,
          metadata: item.metadata,
          provider: item.provider,
          idempotencyKey: item.idempotencyKey,
          timestamp: item.timestamp || now,
          pageId: item.pageId || '',
          contentType: item.contentType || 'VIDEO',
          englishTitle: item.englishTitle || '',
          englishCaption: item.englishCaption || '',
          hashtags: item.hashtags || '',
          scheduledTimeKolkata: item.scheduledTimeKolkata || '',
          scheduledTimeUTC: item.scheduledTimeUTC || '',
          thumbnailMode: item.thumbnailMode || 'auto',
          customThumbnailUrl: item.customThumbnailUrl,
          capturedThumbnailUrl: item.capturedThumbnailUrl,
          durationSeconds: item.durationSeconds,
        });
      }

      this.items = restoredItems;
    } catch {
      // Gracefully prevent crashes from malformed storage data
    }
  }

  public saveToStorage() {
    if (typeof localStorage === 'undefined') return;

    try {
      const serializedItems = this.items.map((item) => {
        // Exclude file reference and any potential secrets (like sessionUri or token)
        return {
          id: item.id,
          fingerprint: item.fingerprint,
          filename: item.filename,
          size: item.size,
          type: item.type,
          lastModified: item.lastModified,
          status: item.status,
          progressPercent: item.progressPercent,
          uploadedBytes: item.uploadedBytes,
          assetId: item.assetId,
          error: item.error,
          retryAttempt: item.retryAttempt,
          metadata: item.metadata,
          provider: item.provider,
          idempotencyKey: item.idempotencyKey,
          timestamp: item.timestamp,
          pageId: item.pageId,
          contentType: item.contentType,
          englishTitle: item.englishTitle,
          englishCaption: item.englishCaption,
          hashtags: item.hashtags,
          scheduledTimeKolkata: item.scheduledTimeKolkata,
          scheduledTimeUTC: item.scheduledTimeUTC,
          thumbnailMode: item.thumbnailMode,
          customThumbnailUrl: item.customThumbnailUrl,
          capturedThumbnailUrl: item.capturedThumbnailUrl,
          durationSeconds: item.durationSeconds,
        };
      });

      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          version: 3,
          items: serializedItems,
        })
      );
    } catch {
      // Gracefully handle storage quota or other issues
    }
  }

  public addFiles(files: File[], defaultPageId = '', maxFileSizeMB = 500) {
    const now = Date.now();
    const addedIds: string[] = [];

    files.forEach((file) => {
      const fingerprint = getFileFingerprint(file);
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

      // Stable client item ID based on fingerprint + index to avoid React key collision if selected again
      const id = 'queue-' + fingerprint;

      // 1. Check if the file already exists in the queue (Duplicate Prevention)
      const existingInQueue = this.items.find(
        (item) => item.fingerprint === fingerprint && item.status !== 'CANCELLED'
      );
      if (existingInQueue) {
        // Add duplicate item in FAILED state as required: "Invalid files should produce an item-specific error without preventing valid files from entering the queue"
        const duplicateId = `${id}-dup-${Math.random().toString(36).substring(2, 7)}`;
        this.items.push({
          id: duplicateId,
          fingerprint,
          filename: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          status: 'FAILED',
          progressPercent: 0,
          uploadedBytes: 0,
          error: 'Duplicate file detected: This file is already in the upload queue.',
          idempotencyKey: `idem-${Math.random().toString(36).substring(2, 11)}`,
          timestamp: now,
          pageId: defaultPageId,
          contentType: 'VIDEO',
          englishTitle: file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' '),
          englishCaption: '',
          hashtags: '',
          scheduledTimeKolkata: '',
          scheduledTimeUTC: '',
          thumbnailMode: 'auto',
        });
        addedIds.push(duplicateId);
        return;
      }

      // Check if selected twice in the same batch (handled by fingerprint check against items we just added)
      const duplicateInBatch = this.items.find(
        (item) => item.fingerprint === fingerprint && addedIds.includes(item.id)
      );
      if (duplicateInBatch) {
        const duplicateId = `${id}-dup-${Math.random().toString(36).substring(2, 7)}`;
        this.items.push({
          id: duplicateId,
          fingerprint,
          filename: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          status: 'FAILED',
          progressPercent: 0,
          uploadedBytes: 0,
          error: 'Duplicate file detected in current selection batch.',
          idempotencyKey: `idem-${Math.random().toString(36).substring(2, 11)}`,
          timestamp: now,
          pageId: defaultPageId,
          contentType: 'VIDEO',
          englishTitle: file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' '),
          englishCaption: '',
          hashtags: '',
          scheduledTimeKolkata: '',
          scheduledTimeUTC: '',
          thumbnailMode: 'auto',
        });
        addedIds.push(duplicateId);
        return;
      }

      // 2. File size and type validations
      let error: string | undefined = undefined;
      if (ext !== '.mp4' && ext !== '.mov') {
        error = 'Unsupported file type. Only MP4 and MOV are allowed.';
      } else if (file.size > maxFileSizeMB * 1024 * 1024) {
        error = `File exceeds maximum configured size of ${maxFileSizeMB} MB.`;
      }

      const newItem: QueueItem = {
        id,
        fingerprint,
        filename: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        status: error ? 'FAILED' : 'QUEUED',
        progressPercent: 0,
        uploadedBytes: 0,
        error,
        idempotencyKey: `idem-${Math.random().toString(36).substring(2, 11)}`,
        timestamp: now,
        file: error ? undefined : file,
        pageId: defaultPageId,
        contentType: 'VIDEO',
        englishTitle: file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' '),
        englishCaption: '',
        hashtags: '',
        scheduledTimeKolkata: '',
        scheduledTimeUTC: '',
        thumbnailMode: 'auto',
      };

      this.items.push(newItem);
      addedIds.push(id);
    });

    this.saveToStorage();
    this.notify();
    this.processQueue();
  }

  public getActiveSlotsCount(): number {
    return this.items.filter((item) =>
      ['INITIATING', 'UPLOADING', 'RECONCILING', 'COMPLETING', 'VALIDATING'].includes(item.status)
    ).length;
  }

  public processQueue() {
    const activeCount = this.getActiveSlotsCount();
    if (activeCount >= this.maxConcurrency) {
      return;
    }

    const nextItem = this.items.find((item) => item.status === 'QUEUED');
    if (!nextItem || !nextItem.file) {
      return;
    }

    this.startUploadItem(nextItem);
    this.processQueue(); // fill remaining slots
  }

  private startUploadItem(item: QueueItem) {
    if (this.uploaders.has(item.id)) {
      return;
    }
    if (!item.file) {
      item.status = 'NEEDS_FILE_RESELECTION';
      this.saveToStorage();
      this.notify();
      return;
    }

    // Set stable recoveryKey equal to item.id
    const recoveryKey = item.id;

    // Create uploader instance
    const uploader = new BrowserMultipartUploader({
      file: item.file,
      assetId: item.assetId,
      recoveryKey,
      idempotencyKey: item.idempotencyKey,
      onStatusChange: (status) => {
        this.handleUploaderStatusChange(item.id, status);
      },
      transport: this.transport,
    });

    this.uploaders.set(item.id, uploader);
    item.status = 'INITIATING';
    this.saveToStorage();
    this.notify();

    uploader.start().catch((err) => {
      // Error handled via onStatusChange callback mostly, but safety catch
      if (item.status === 'INITIATING') {
        item.status = 'FAILED';
        item.error = err instanceof Error ? err.message : 'Initiation failed';
        this.saveToStorage();
        this.notify();
        this.cleanupUploader(item.id);
        this.processQueue();
      }
    });
  }

  private handleUploaderStatusChange(itemId: string, status: BrowserUploaderStatus) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;

    item.progressPercent = status.progressPercent;
    item.uploadedBytes = status.uploadedBytes;
    if (status.assetId) item.assetId = status.assetId;
    if (status.provider) item.provider = status.provider;
    if (status.metadata) {
      item.metadata = status.metadata;
      if (status.metadata.durationMs) {
        item.durationSeconds = Math.round(status.metadata.durationMs / 1000);
      }
    }

    // Map uploader state to queue item status
    let mappedStatus: QueueItemState = item.status;
    switch (status.state) {
      case 'idle':
      case 'selected':
        mappedStatus = 'QUEUED';
        break;
      case 'initiating':
        mappedStatus = 'INITIATING';
        break;
      case 'uploading':
        mappedStatus = 'UPLOADING';
        break;
      case 'paused':
        mappedStatus = 'PAUSED';
        break;
      case 'retrying':
        mappedStatus = 'RETRY_WAIT';
        break;
      case 'completing':
        mappedStatus = 'COMPLETING';
        break;
      case 'validating':
        mappedStatus = 'VALIDATING';
        break;
      case 'validated':
        mappedStatus = 'VALIDATED';
        break;
      case 'failed':
        mappedStatus = 'FAILED';
        item.error = status.error || 'Upload failed';
        break;
      case 'aborting':
      case 'aborted':
        mappedStatus = 'CANCELLED';
        break;
    }

    const wasActive = ['INITIATING', 'UPLOADING', 'RECONCILING', 'COMPLETING', 'VALIDATING'].includes(item.status);
    const isNowActive = ['INITIATING', 'UPLOADING', 'RECONCILING', 'COMPLETING', 'VALIDATING'].includes(mappedStatus);

    item.status = mappedStatus;

    if (mappedStatus === 'VALIDATED' && item.assetId && item.metadata && this.onUploadValidated) {
      this.onUploadValidated(item.id, item.assetId, item.metadata);
    }

    this.saveToStorage();
    this.notify();

    // If transitioned out of active states, cleanup uploader and trigger queue processing
    if (wasActive && !isNowActive) {
      this.cleanupUploader(itemId);
      this.processQueue();
    }
  }

  private cleanupUploader(itemId: string) {
    const uploader = this.uploaders.get(itemId);
    if (uploader) {
      uploader.destroy();
      this.uploaders.delete(itemId);
    }
  }

  public pauseUpload(itemId: string) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;

    const uploader = this.uploaders.get(itemId);
    if (uploader) {
      uploader.pause();
    } else {
      item.status = 'PAUSED';
      this.saveToStorage();
      this.notify();
      this.processQueue();
    }
  }

  public resumeUpload(itemId: string) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;

    if (item.status !== 'PAUSED') return;

    // Check if slot available
    const activeCount = this.getActiveSlotsCount();
    if (activeCount >= this.maxConcurrency) {
      item.status = 'QUEUED';
      this.saveToStorage();
      this.notify();
      return;
    }

    if (!item.file) {
      item.status = 'NEEDS_FILE_RESELECTION';
      this.saveToStorage();
      this.notify();
      return;
    }

    // Set state to RECONCILING first
    item.status = 'RECONCILING';
    item.error = undefined;
    this.saveToStorage();
    this.notify();

    fetch(`/api/uploads/${item.assetId}/reconcile`, { method: 'POST' })
      .then(async (res) => {
        if (res.ok) {
          const reconData = await res.json();
          if (reconData && typeof reconData.confirmedBytes === 'number') {
            item.uploadedBytes = reconData.confirmedBytes;
            item.progressPercent = item.size > 0 ? Math.round((reconData.confirmedBytes / item.size) * 100) : 0;
          }
        }
      })
      .catch(() => {
        // Ignore background reconciliation errors and let uploader handle it
      })
      .finally(() => {
        if (item.status !== 'RECONCILING') return;

        const uploader = new BrowserMultipartUploader({
          file: item.file!,
          assetId: item.assetId,
          recoveryKey: item.id,
          idempotencyKey: item.idempotencyKey,
          onStatusChange: (status) => {
            this.handleUploaderStatusChange(item.id, status);
          },
          transport: this.transport,
        });

        this.uploaders.set(item.id, uploader);

        uploader.resume().catch((err) => {
          if (item.status === 'RECONCILING' || item.status === 'UPLOADING') {
            item.status = 'FAILED';
            item.error = err instanceof Error ? err.message : 'Resume failed';
            this.saveToStorage();
            this.notify();
            this.cleanupUploader(item.id);
            this.processQueue();
          }
        });
      });
  }

  public retryUpload(itemId: string) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;

    if (item.status !== 'FAILED') return;

    item.status = 'QUEUED';
    item.error = undefined;
    this.saveToStorage();
    this.notify();
    this.processQueue();
  }

  public async cancelUpload(itemId: string) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;

    const uploader = this.uploaders.get(itemId);
    if (uploader) {
      await uploader.cancel();
    } else {
      // If uploader not loaded, but has assetId, call abort route directly
      if (item.assetId) {
        try {
          item.status = 'CANCELLED';
          this.saveToStorage();
          this.notify();
          await fetch(`/api/uploads/${item.assetId}/abort`, { method: 'POST' });
        } catch {
          // Ignore fetch failure
        }
      } else {
        item.status = 'CANCELLED';
        this.saveToStorage();
        this.notify();
      }
    }
    this.cleanupUploader(itemId);
    this.processQueue();
  }

  public async removeItem(itemId: string) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;

    // "Removing an active upload should require cancellation/cleanup first or perform safe cancellation automatically."
    const isActive = ['INITIATING', 'UPLOADING', 'RECONCILING', 'COMPLETING', 'VALIDATING', 'RETRY_WAIT'].includes(
      item.status
    );
    if (isActive) {
      await this.cancelUpload(itemId);
    } else {
      this.cleanupUploader(itemId);
    }

    this.items = this.items.filter((i) => i.id !== itemId);
    this.saveToStorage();
    this.notify();
    this.processQueue();
  }

  public reselectFile(itemId: string, file: File): { success: boolean; error?: string } {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return { success: false, error: 'Item not found.' };

    const matches =
      item.filename === file.name &&
      item.size === file.size &&
      (item.type === file.type || (!item.type && !file.type)) &&
      item.lastModified === file.lastModified;

    if (!matches) {
      return { success: false, error: 'RECOVERY_FILE_MISMATCH' };
    }

    item.file = file;
    item.status = 'PAUSED';
    item.error = undefined;
    this.saveToStorage();
    this.notify();
    this.processQueue();
    return { success: true };
  }

  public updateJobFields(itemId: string, fields: Partial<QueueItem>) {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return;

    Object.assign(item, fields);
    this.saveToStorage();
    this.notify();
  }

  public clearAll() {
    this.items.forEach((item) => {
      this.cleanupUploader(item.id);
    });
    this.items = [];
    this.saveToStorage();
    this.notify();
  }

  public reconcileRestoredItems() {
    // For each item restored (which is currently in NEEDS_FILE_RESELECTION or VALIDATED),
    // query /api/uploads/${assetId} to see if it is completed or validated on the server.
    this.items.forEach(async (item) => {
      if (!item.assetId) return;

      try {
        const res = await fetch(`/api/uploads/${item.assetId}`);
        if (!res.ok) {
          if (res.status === 404 || res.status === 410) {
            item.status = 'FAILED';
            item.error = 'Upload session has expired or was not found on the server.';
            this.saveToStorage();
            this.notify();
          }
          return;
        }

        const serverData = await res.json();
        if (serverData.status === 'VALIDATED') {
          item.status = 'VALIDATED';
          item.progressPercent = 100;
          item.uploadedBytes = item.size;
          if (serverData.durationMs) {
            item.durationSeconds = Math.round(serverData.durationMs / 1000);
            item.metadata = {
              durationMs: serverData.durationMs,
              width: serverData.width,
              height: serverData.height,
              frameRate: serverData.frameRate,
              videoCodec: serverData.videoCodec,
              audioCodec: serverData.audioCodec,
              containerFormat: serverData.containerFormat,
              detectedMimeType: serverData.detectedMimeType,
            };
          }
          this.saveToStorage();
          this.notify();

          // Sync validated fields with DashboardClient
          if (this.onUploadValidated && item.metadata) {
            this.onUploadValidated(item.id, item.assetId, item.metadata);
          }
        } else if (serverData.status === 'FAILED') {
          item.status = 'FAILED';
          item.error = serverData.failureMessage || 'Upload validation failed on server.';
          this.saveToStorage();
          this.notify();
        } else if (serverData.status === 'ABORTED') {
          item.status = 'CANCELLED';
          this.saveToStorage();
          this.notify();
        }
      } catch {
        // Ignore network errors during background sync
      }
    });
  }
}
