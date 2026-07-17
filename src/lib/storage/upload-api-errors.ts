import { NextResponse } from 'next/server';
import {
  NotFoundError,
  ForbiddenOwnershipError,
  ExpiredSessionError,
  IdempotencyConflictError,
  InvalidStateTransitionError,
  InvalidMultipartMetadataError,
  ConfigurationError,
} from './upload-session-encryption';
import { FinalizationOperationConflictError, FinalizationInProgressError } from './finalization-claim-service';
import { MultipartUploadNotFoundError } from './storage-adapter';

export function handleUploadApiError(error: unknown) {
  console.error('Upload API Error:', error);

  if (error instanceof Error) {
    if (error.message === 'INVALID_PROVIDER') {
      return NextResponse.json({ error: 'INVALID_PROVIDER' }, { status: 400 });
    }
    if (error.message === 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE') {
      return NextResponse.json({ error: 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE' }, { status: 502 });
    }
    if (error.message === 'UPLOAD_SESSION_RESTART_REQUIRED') {
      return NextResponse.json({ error: 'UPLOAD_SESSION_RESTART_REQUIRED' }, { status: 400 });
    }
    if (error.message === 'GOOGLE_DRIVE_UPLOAD_FAILED') {
      return NextResponse.json({ error: 'GOOGLE_DRIVE_UPLOAD_FAILED' }, { status: 502 });
    }
    if (error.message === 'INVALID_IDEMPOTENCY_KEY') {
      return NextResponse.json({ error: 'INVALID_IDEMPOTENCY_KEY' }, { status: 400 });
    }
    if (error.message === 'INVALID_FILENAME') {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    if (error.message === 'FILE_TOO_LARGE') {
      return NextResponse.json({ error: 'FILE_TOO_LARGE' }, { status: 413 });
    }
    if (error.message === 'UNSUPPORTED_MEDIA_TYPE') {
      return NextResponse.json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 });
    }
    if (error.message === 'MIME_MISMATCH') {
      return NextResponse.json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 415 });
    }
    if (error.message === 'INVALID_PART_COUNT') {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
  }

  if (error instanceof NotFoundError || error instanceof ForbiddenOwnershipError) {
    return NextResponse.json({ error: 'UPLOAD_NOT_FOUND' }, { status: 404 });
  }

  if (error instanceof ExpiredSessionError) {
    // Expired session returns 410 with safe error code
    return NextResponse.json({ error: 'UPLOAD_SESSION_EXPIRED' }, { status: 410 });
  }

  if (error instanceof IdempotencyConflictError) {
    return NextResponse.json({ error: 'IDEMPOTENCY_CONFLICT' }, { status: 409 });
  }

  if (error instanceof InvalidStateTransitionError) {
    return NextResponse.json({ error: 'INVALID_UPLOAD_STATE' }, { status: 400 });
  }

  if (error instanceof InvalidMultipartMetadataError) {
    const isEtag = error.message.toLowerCase().includes('etag');
    return NextResponse.json(
      { error: isEtag ? 'INVALID_ETAG' : 'INVALID_PART_NUMBER' },
      { status: 400 }
    );
  }

  if (error instanceof FinalizationOperationConflictError) {
    return NextResponse.json({ error: 'FINALIZATION_OPERATION_CONFLICT' }, { status: 409 });
  }

  if (error instanceof FinalizationInProgressError) {
    return NextResponse.json({ error: 'FINALIZATION_IN_PROGRESS' }, { status: 409 });
  }

  if (error instanceof MultipartUploadNotFoundError) {
    return NextResponse.json({ error: 'MULTIPART_NOT_FOUND' }, { status: 502 });
  }

  if (error instanceof ConfigurationError) {
    return NextResponse.json({ error: 'STORAGE_UNAVAILABLE' }, { status: 503 });
  }

  // Handle generic validation or other database errors
  return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
}
