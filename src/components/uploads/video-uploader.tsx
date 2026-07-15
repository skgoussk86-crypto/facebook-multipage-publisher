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
          onUploadValidated(newStatus.assetId, durationSeconds);
        }
      },
    });

    uploaderRef.current = uploader;

    return () => {
      uploader.destroy();
    };
  }, [file, initialAssetId, recoveryKey, onUploadValidated]);

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
          <div className="bg-emerald-950/20 border border-emerald-900/40 rounded-lg p-3 text-xs text-emerald-400 space-y-1 w-full">
            <div className="font-bold flex items-center gap-1.5 mb-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
              ✓ Video Verified & Validated
            </div>
            {metadata && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[10px] text-zinc-300">
                <div>Duration: <span className="text-white font-semibold">{Math.round((metadata.durationMs || 0) / 1000)}s</span></div>
                <div>Format: <span className="text-white font-semibold">{metadata.containerFormat}</span></div>
                <div>Video Codec: <span className="text-white font-semibold">{metadata.videoCodec}</span></div>
                {metadata.audioCodec && <div>Audio Codec: <span className="text-white font-semibold">{metadata.audioCodec}</span></div>}
                {metadata.width && metadata.height && (
                  <div>Resolution: <span className="text-white font-semibold">{metadata.width}x{metadata.height}</span></div>
                )}
                {metadata.frameRate && <div>Frame Rate: <span className="text-white font-semibold">{metadata.frameRate}fps</span></div>}
              </div>
            )}
          </div>
        );
      case 'failed':
        return (
          <div className="bg-rose-950/20 border border-rose-900/40 rounded-lg p-3 text-xs text-rose-400 font-medium w-full space-y-2">
            <span className="font-bold block text-rose-500">✗ Upload Failed</span>
            {error === 'RECOVERY_FILE_MISMATCH' ? (
              <div>
                <p className="font-semibold text-rose-400">File metadata mismatch.</p>
                <p className="text-[11px] text-zinc-400 mt-1">
                  The selected file name, size, or MIME type does not match the active recovery session.
                  Please select the correct file to resume, or cancel/clear this recovery session.
                </p>
              </div>
            ) : (
              error || 'An unexpected error occurred during upload or validation.'
            )}
          </div>
        );
      case 'aborting':
        return <span className="text-rose-400 text-xs animate-pulse">Aborting multipart session...</span>;
      case 'aborted':
        return <span className="text-rose-500 text-xs font-semibold">Upload aborted by user.</span>;
      default:
        return null;
    }
  };

  return (
    <div className="bg-zinc-900/60 backdrop-blur-md border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition flex flex-col gap-4 shadow-lg w-full">
      {/* File Info */}
      <div className="flex justify-between items-start">
        <div className="flex-1 min-w-0 pr-4">
          <h4 className="font-bold text-sm text-white truncate" title={file.name}>
            {file.name}
          </h4>
          <p className="text-xs text-zinc-500 font-mono mt-0.5">{formatBytes(file.size)}</p>
        </div>
        <button
          onClick={onRemove}
          className="text-xs text-zinc-500 hover:text-rose-500 hover:underline transition ml-auto"
        >
          Remove Card
        </button>
      </div>

      {/* Progress Info */}
      <div className="flex flex-col gap-2">
        {renderStatusDetails()}

        {/* Progress Bar Container */}
        {['uploading', 'paused', 'retrying', 'completing', 'validating', 'validated'].includes(status.state) && (
          <div className="w-full bg-zinc-950 rounded-full h-2 overflow-hidden border border-zinc-800">
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
      <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-800/60 justify-end">
        {status.state === 'selected' && (
          <button
            onClick={handleStart}
            className="bg-indigo-650 hover:bg-indigo-600 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition shadow-md shadow-indigo-650/20"
          >
            Start Upload
          </button>
        )}

        {(status.state === 'uploading' || status.state === 'retrying') && (
          <>
            <button
              onClick={handlePause}
              className="bg-zinc-800 hover:bg-zinc-750 text-amber-500 border border-zinc-700 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Pause
            </button>
            <button
              onClick={handleCancel}
              className="bg-rose-950/30 hover:bg-rose-950/50 text-rose-400 border border-rose-900/40 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status.state === 'paused' && (
          <>
            <button
              onClick={handleResume}
              className="bg-indigo-650 hover:bg-indigo-600 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition"
            >
              Resume
            </button>
            <button
              onClick={handleCancel}
              className="bg-rose-950/30 hover:bg-rose-950/50 text-rose-400 border border-rose-900/40 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status.state === 'failed' && (
          <>
            <button
              onClick={handleRetry}
              className="bg-indigo-650 hover:bg-indigo-600 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition"
            >
              Retry
            </button>
            <button
              onClick={handleCancel}
              className="bg-rose-950/30 hover:bg-rose-950/50 text-rose-400 border border-rose-900/40 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status.state === 'aborted' && (
          <button
            onClick={onRemove}
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold py-1.5 px-4 rounded-lg text-xs transition"
          >
            Remove Item
          </button>
        )}
      </div>
    </div>
  );
}
