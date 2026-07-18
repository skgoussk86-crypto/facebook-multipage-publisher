import React from 'react';
import { QueueItemState } from '../../lib/uploads/upload-queue-controller';
import { VideoMetadata } from '../../lib/uploads/upload-types';

interface VideoUploaderProps {
  itemId: string;
  filename: string;
  size: number;
  status: QueueItemState;
  progressPercent: number;
  uploadedBytes: number;
  error?: string;
  metadata?: VideoMetadata;

  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onReselectFile: (file: File) => void;
  onRemove: () => void;
}

export default function VideoUploader({
  filename,
  size,
  status,
  progressPercent,
  uploadedBytes,
  error,
  metadata,
  onStart,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onReselectFile,
  onRemove,
}: VideoUploaderProps) {
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KiB', 'MiB', 'GiB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const renderStatusDetails = () => {
    switch (status) {
      case 'QUEUED':
        return (
          <span className="text-zinc-400 text-xs font-semibold animate-pulse">
            Queued (waiting for available upload slot)... File size: {formatBytes(size)}.
          </span>
        );
      case 'INITIATING':
        return <span className="text-indigo-400 text-xs animate-pulse">Initiating secure multipart session...</span>;
      case 'UPLOADING':
        return (
          <div className="flex flex-col gap-1 w-full">
            <div className="flex justify-between items-center text-xs text-zinc-400">
              <span>Uploading chunks...</span>
              <span>{formatBytes(uploadedBytes)} of {formatBytes(size)} ({progressPercent}%)</span>
            </div>
          </div>
        );
      case 'PAUSED':
        return (
          <span className="text-amber-500 text-xs font-semibold">
            Upload paused. ({progressPercent}% uploaded)
          </span>
        );
      case 'RECONCILING':
        return <span className="text-indigo-400 text-xs animate-pulse font-semibold">Reconciling server/provider progress...</span>;
      case 'COMPLETING':
        return <span className="text-cyan-400 text-xs animate-pulse">Finalizing uploaded parts on server...</span>;
      case 'VALIDATING':
        return <span className="text-amber-400 text-xs animate-pulse">Probing and validating media metadata...</span>;
      case 'VALIDATED':
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
      case 'RETRY_WAIT':
        return (
          <span className="text-indigo-400 text-xs animate-pulse font-semibold">
            Network error. Retrying chunk...
          </span>
        );
      case 'NEEDS_FILE_RESELECTION':
        return (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-xs text-amber-800 space-y-2 w-full">
            <span className="font-bold block text-amber-700">⚠ Action Required: Reselect file to resume</span>
            <p className="text-[11px] text-zinc-600">
              The page was refreshed, but the upload was not complete. Please reselect the original file <strong>{filename}</strong> ({formatBytes(size)}) to resume.
            </p>
            <div className="pt-2">
              <label className="bg-amber-600 hover:bg-amber-500 text-white font-bold py-1 px-3 rounded text-[10px] cursor-pointer transition shadow-sm">
                Reselect file to resume
                <input
                  type="file"
                  accept=".mp4,.mov"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onReselectFile(file);
                  }}
                />
              </label>
            </div>
            {error && (
              <p className="text-[10px] text-rose-600 font-semibold mt-1 font-mono">
                Error: {error === 'RECOVERY_FILE_MISMATCH' ? 'File metadata mismatch. Please select the correct file.' : error}
              </p>
            )}
          </div>
        );
      case 'FAILED':
        return (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 text-xs text-rose-800 font-medium w-full space-y-2">
            <span className="font-bold block text-rose-700">✗ Upload Failed</span>
            <p className="text-[11px] text-rose-600 font-mono">{error || 'An unexpected error occurred during upload or validation.'}</p>
          </div>
        );
      case 'CANCELLED':
        return <span className="text-rose-600 text-xs font-semibold">Upload cancelled/aborted by user.</span>;
      default:
        return null;
    }
  };

  const showProgressBar = ['UPLOADING', 'PAUSED', 'RETRY_WAIT', 'RECONCILING', 'COMPLETING', 'VALIDATING', 'VALIDATED'].includes(status);

  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition flex flex-col gap-4 shadow-sm w-full">
      {/* File Info */}
      <div className="flex justify-between items-start">
        <div className="flex-1 min-w-0 pr-4">
          <h4 className="font-bold text-sm text-zinc-900 truncate" title={filename}>
            {filename}
          </h4>
          <p className="text-xs text-zinc-500 font-mono mt-0.5">{formatBytes(size)}</p>
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
        {showProgressBar && (
          <div className="w-full bg-zinc-200 rounded-full h-2 overflow-hidden border border-zinc-300">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                status === 'VALIDATED'
                  ? 'bg-emerald-500'
                  : ['VALIDATING', 'COMPLETING', 'RECONCILING'].includes(status)
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-indigo-500'
              }`}
              style={{ width: `${progressPercent}%` }}
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        )}
      </div>

      {/* Action Controls */}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-200 justify-end">
        {status === 'QUEUED' && (
          <button
            onClick={onStart}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition shadow-md shadow-indigo-600/20"
          >
            Start Upload
          </button>
        )}

        {['INITIATING', 'UPLOADING', 'RETRY_WAIT', 'RECONCILING', 'COMPLETING', 'VALIDATING'].includes(status) && (
          <>
            <button
              onClick={onPause}
              className="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Pause
            </button>
            <button
              onClick={onCancel}
              className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status === 'PAUSED' && (
          <>
            <button
              onClick={onResume}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition"
            >
              Resume
            </button>
            <button
              onClick={onCancel}
              className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status === 'FAILED' && (
          <>
            <button
              onClick={onRetry}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-1.5 px-4 rounded-lg text-xs transition"
            >
              Retry
            </button>
            <button
              onClick={onCancel}
              className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
            >
              Cancel
            </button>
          </>
        )}

        {status === 'NEEDS_FILE_RESELECTION' && (
          <button
            onClick={onCancel}
            className="bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold py-1.5 px-3.5 rounded-lg text-xs transition"
          >
            Cancel
          </button>
        )}

        {['CANCELLED', 'FAILED'].includes(status) === false && status !== 'VALIDATED' && (
          // Add a spacer or keep empty if no buttons
          null
        )}

        {status === 'CANCELLED' && (
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
