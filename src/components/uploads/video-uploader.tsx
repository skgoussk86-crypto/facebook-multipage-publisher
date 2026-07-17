import React, { useEffect, useState, useRef } from 'react';
import { BrowserMultipartUploader } from '../../lib/uploads/browser-multipart-uploader';
import { BrowserUploaderStatus } from '../../lib/uploads/upload-types';

interface VideoUploaderProps {
  file: File;
  onUploadValidated: (assetId: string, durationSeconds: number) => void;
  onRemove: () => void;
  initialAssetId?: string;
  recoveryKey: string;
}

export default function VideoUploader({
  file,
  onUploadValidated,
  onRemove,
  initialAssetId,
  recoveryKey,
}: VideoUploaderProps) {
  const [status, setStatus] = useState<BrowserUploaderStatus>(() => {
    let assetId = initialAssetId;
    if (!assetId && typeof window !== 'undefined' && recoveryKey) {
      try {
        const stored = localStorage.getItem(`upload_recovery_${recoveryKey}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          assetId = parsed.assetId;
        }
      } catch {
        // Ignore
      }
    }
    return {
      state: assetId ? 'paused' : 'selected',
      progressPercent: 0,
      uploadedBytes: 0,
      totalBytes: file.size,
      assetId,
    };
  });

  const uploaderRef = useRef<BrowserMultipartUploader | null>(null);
  const onUploadValidatedRef = useRef(onUploadValidated);

  useEffect(() => {
    onUploadValidatedRef.current = onUploadValidated;
  }, [onUploadValidated]);

  useEffect(() => {
    let active = true;
    let assetId = initialAssetId;
    if (!assetId && recoveryKey) {
      try {
        const stored = localStorage.getItem(`upload_recovery_${recoveryKey}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          assetId = parsed.assetId;
        }
      } catch {
        // Ignore
      }
    }

    if (assetId) {
      fetch(`/api/uploads/${assetId}`)
        .then((res) => {
          if (res.ok) return res.json();
          throw new Error('Sync failed');
        })
        .then((data) => {
          if (active && data) {
            if (data.provider === 'GOOGLE_DRIVE') {
              return;
            }
            const completedCount = (data.completedPartNumbers || []).length;
            const progress = data.totalParts > 0 ? Math.round((completedCount / data.totalParts) * 100) : 0;
            const partSize = data.partSize || 10 * 1024 * 1024;
            let bytes = 0;
            for (const partNum of data.completedPartNumbers || []) {
              if (partNum === data.totalParts) {
                const remainder = file.size % partSize;
                bytes += remainder === 0 ? partSize : remainder;
              } else {
                bytes += partSize;
              }
            }

            setStatus((prev) => ({
              ...prev,
              progressPercent: progress,
              uploadedBytes: bytes,
            }));
          }
        })
        .catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [file, initialAssetId, recoveryKey]);

  useEffect(() => {
    let assetId = initialAssetId;
    if (!assetId && recoveryKey) {
      try {
        const stored = localStorage.getItem(`upload_recovery_${recoveryKey}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          assetId = parsed.assetId;
        }
      } catch {
        // Ignore
      }
    }

    const uploader = new BrowserMultipartUploader({
      file,
      assetId,
      recoveryKey,
      onStatusChange: (newStatus) => {
        setStatus(newStatus);

        // Notify parent when validation succeeds
        if (newStatus.state === 'validated' && newStatus.assetId && newStatus.metadata) {
          const durationSeconds = Math.round((newStatus.metadata.durationMs || 0) / 1000);
          onUploadValidatedRef.current(newStatus.assetId, durationSeconds);
        }
      },
    });

    uploaderRef.current = uploader;

    return () => {
      uploader.destroy();
    };
  }, [file, initialAssetId, recoveryKey]);

  const handleStart = () => {
    uploaderRef.current?.start();
  };

  const handlePause = () => {
    uploaderRef.current?.pause();
  };

  const handleResume = () => {
    uploaderRef.current?.resume();
  };

  const handleCancel = () => {
    if (confirm('Are you sure you want to cancel and abort this upload? In-flight chunks will be discarded.')) {
      uploaderRef.current?.cancel();
    }
  };

  const handleRetry = () => {
    uploaderRef.current?.retry();
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KiB', 'MiB', 'GiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const renderStatusDetails = () => {
    const { state, progressPercent, uploadedBytes, totalBytes, error, metadata } = status;

    switch (state) {
      case 'selected':
        return (
          <span className="text-zinc-400 text-xs">
            Ready to upload. File size: {formatBytes(totalBytes)}.
          </span>
        );
      case 'initiating':
        return <span className="text-indigo-400 text-xs animate-pulse">Initiating secure multipart session...</span>;
      case 'uploading':
        return (
          <div className="flex flex-col gap-1 w-full">
            <div className="flex justify-between items-center text-xs text-zinc-400">
              <span>Uploading chunks...</span>
              <span>{formatBytes(uploadedBytes)} of {formatBytes(totalBytes)} ({progressPercent}%)</span>
            </div>
          </div>
        );
      case 'paused':
        return (
          <span className="text-amber-500 text-xs font-semibold">
            Upload paused. ({progressPercent}% uploaded)
          </span>
        );
      case 'retrying':
        return (
          <span className="text-indigo-400 text-xs animate-pulse font-semibold">
            Network error. Retrying chunk (Attempt {status.retryAttempt})...
          </span>
        );
      case 'completing':
        return <span className="text-cyan-400 text-xs animate-pulse">Finalizing uploaded parts on server...</span>;
      case 'validating':
        return <span className="text-amber-400 text-xs animate-pulse">Probing and validating media metadata...</span>;
      case 'validated':
        return (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-xs text-emerald-800 space-y-2 w-full shadow-sm">
            <div className="font-bold flex items-center gap-1.5 mb-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
              ✓ Video Verified & Validated
            </div>
            {metadata && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 font-mono text-[10.5px] text-zinc-600 border-t border-emerald-100 pt-2 break-words">
                <div><span className="font-semibold text-zinc-500">Duration:</span> <span className="text-emerald-900 font-bold">{Math.round((metadata.durationMs || 0) / 1000)}s</span></div>
                <div><span className="font-semibold text-zinc-500">Format:</span> <span className="text-emerald-900 font-bold">{metadata.containerFormat}</span></div>
                <div><span className="font-semibold text-zinc-500">Video Codec:</span> <span className="text-emerald-900 font-bold">{metadata.videoCodec}</span></div>
                {metadata.audioCodec && <div><span className="font-semibold text-zinc-500">Audio Codec:</span> <span className="text-emerald-900 font-bold">{metadata.audioCodec}</span></div>}
                {metadata.width && metadata.height && (
                  <div><span className="font-semibold text-zinc-500">Resolution:</span> <span className="text-emerald-900 font-bold">{metadata.width}×{metadata.height}</span></div>
                )}
                {metadata.frameRate && <div><span className="font-semibold text-zinc-500">Frame Rate:</span> <span className="text-emerald-900 font-bold">{metadata.frameRate} fps</span></div>}
              </div>
            )}
          </div>
        );
      case 'failed':
        return (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 text-xs text-rose-800 font-medium w-full space-y-2">
            <span className="font-bold block text-rose-700">✗ Upload Failed</span>
            {error === 'RECOVERY_FILE_MISMATCH' ? (
              <div>
                <p className="font-semibold text-rose-600">File metadata mismatch.</p>
                <p className="text-[11px] text-zinc-600 mt-1">
                  The selected file name, size, or MIME type does not match the active recovery session.
                  Please select the correct file to resume, or cancel/clear this recovery session.
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-rose-600">{error || 'An unexpected error occurred during upload or validation.'}</p>
            )}
          </div>
        );
      case 'aborting':
        return <span className="text-rose-600 text-xs animate-pulse">Aborting multipart session...</span>;
      case 'aborted':
        return <span className="text-rose-600 text-xs font-semibold">Upload aborted by user.</span>;
      default:
        return null;
    }
  };

  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition flex flex-col gap-4 shadow-sm w-full">
      {/* File Info */}
      <div className="flex justify-between items-start">
        <div className="flex-1 min-w-0 pr-4">
          <h4 className="font-bold text-sm text-zinc-900 truncate" title={file.name}>
            {file.name}
          </h4>
          <p className="text-xs text-zinc-500 font-mono mt-0.5">{formatBytes(file.size)}</p>
        </div>
        <button
          onClick={onRemove}
          className="text-xs text-zinc-500 hover:text-rose-600 hover:underline transition ml-auto"
        >
          Remove Card
        </button>
      </div>

      {/* Progress Info */}
      <div className="flex flex-col gap-2">
        {renderStatusDetails()}

        {/* Progress Bar Container */}
        {['uploading', 'paused', 'retrying', 'completing', 'validating', 'validated'].includes(status.state) && (
          <div className="w-full bg-zinc-200 rounded-full h-2 overflow-hidden border border-zinc-300">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                status.state === 'validated'
                  ? 'bg-emerald-500'
                  : status.state === 'validating'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-indigo-500'
              }`}
              style={{ width: `${status.progressPercent}%` }}
              role="progressbar"
              aria-valuenow={status.progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        )}
      </div>

      {/* Action Controls */}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-200 justify-end">
        {status.state === 'selected' && (
          <button
            onClick={handleStart}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition shadow-md shadow-indigo-600/20"
          >
            Start Upload
          </button>
        )}

        {(status.state === 'uploading' || status.state === 'retrying') && (
          <>
            <button
              onClick={handlePause}
              className="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Pause
            </button>
            <button
              onClick={handleCancel}
              className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status.state === 'paused' && (
          <>
            <button
              onClick={handleResume}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition"
            >
              Resume
            </button>
            <button
              onClick={handleCancel}
              className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status.state === 'failed' && (
          <>
            <button
              onClick={handleRetry}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition"
            >
              Retry
            </button>
            <button
              onClick={handleCancel}
              className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status.state === 'aborted' && (
          <button
            onClick={onRemove}
            className="bg-zinc-100 hover:bg-zinc-200 text-zinc-700 border border-zinc-200 font-semibold py-1.5 px-4 rounded-lg text-xs transition"
          >
            Remove Item
          </button>
        )}
      </div>
    </div>
  );
}
