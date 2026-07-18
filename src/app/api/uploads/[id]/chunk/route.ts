import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma-client';
import {
  UploadSessionService,
  handleUploadApiError,
  NotFoundError,
  ForbiddenOwnershipError,
  ExpiredSessionError,
} from '@/lib/storage';
import { GoogleDriveUploadCompletionService } from '@/lib/google-drive/google-drive-upload-completion-service';

export const dynamic = 'force-dynamic';

const MAX_PROXY_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MiB

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

export interface ChunkPutDependencies {
  verifyAdminSession?: typeof verifyAdminSession;
  getDecryptedSession?: typeof UploadSessionService.getDecryptedSession;
  completeUpload?: typeof GoogleDriveUploadCompletionService.completeUpload;
}

export function createChunkPutHandler(deps?: ChunkPutDependencies) {
  return async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) {
    try {
      const { id: assetId } = await params;

      // 1. Authenticate user
      const authHelper = deps?.verifyAdminSession || verifyAdminSession;
      const user = await authHelper(request);
      if (!user) {
        return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
      }

      // 2. Retrieve UploadAsset and verify provider
      const asset = await prisma.uploadAsset.findUnique({
        where: { id: assetId },
      });
      if (!asset) {
        return NextResponse.json({ error: 'UPLOAD_NOT_FOUND' }, { status: 404 });
      }
      if (asset.userId !== user.id) {
        return NextResponse.json({ error: 'FORBIDDEN_OWNERSHIP' }, { status: 403 });
      }
      if (asset.provider !== 'GOOGLE_DRIVE') {
        return NextResponse.json({ error: 'INVALID_PROVIDER' }, { status: 400 });
      }

      // 3. Retrieve and decrypt session details (verifies status and expiry)
      let decryptedSessionId: string;
      try {
        const getSessionHelper = deps?.getDecryptedSession || UploadSessionService.getDecryptedSession;
        const session = await getSessionHelper(user.id, assetId);
        decryptedSessionId = session.providerSessionId;
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          return NextResponse.json({ error: 'UPLOAD_SESSION_NOT_FOUND' }, { status: 404 });
        }
        if (err instanceof ForbiddenOwnershipError) {
          return NextResponse.json({ error: 'FORBIDDEN_OWNERSHIP' }, { status: 403 });
        }
        if (err instanceof ExpiredSessionError) {
          return NextResponse.json({ error: 'UPLOAD_SESSION_EXPIRED' }, { status: 410 });
        }
        throw err;
      }

      // 4. Validate headers & Content-Range
      const contentRange = request.headers.get('Content-Range');
      const contentLengthHeader = request.headers.get('Content-Length');
      const contentType = request.headers.get('Content-Type') || 'video/mp4';

      if (!contentRange || !contentLengthHeader) {
        return NextResponse.json({ error: 'MISSING_HEADERS' }, { status: 400 });
      }

      const contentLength = Number(contentLengthHeader);
      if (isNaN(contentLength) || contentLength <= 0) {
        return NextResponse.json({ error: 'INVALID_CONTENT_LENGTH' }, { status: 400 });
      }

      if (contentLength > MAX_PROXY_CHUNK_SIZE) {
        return NextResponse.json({ error: 'CHUNK_TOO_LARGE' }, { status: 400 });
      }

      const rangeMatch = contentRange.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
      if (!rangeMatch) {
        return NextResponse.json({ error: 'INVALID_CONTENT_RANGE' }, { status: 400 });
      }

      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const total = Number(rangeMatch[3]);

      if (
        start < 0 ||
        end < start ||
        total !== Number(asset.expectedSize) ||
        end >= total ||
        end - start + 1 !== contentLength
      ) {
        return NextResponse.json({ error: 'INVALID_RANGE_VALUES' }, { status: 400 });
      }

      if (!request.body) {
        return NextResponse.json({ error: 'MISSING_REQUEST_BODY' }, { status: 400 });
      }

      // 5. Forward chunk via fetch (streaming without buffering)
      let googleResponse: Response;
      try {
        googleResponse = await fetch(decryptedSessionId, {
          method: 'PUT',
          headers: {
            'Content-Range': contentRange,
            'Content-Length': contentLength.toString(),
            'Content-Type': contentType,
          },
          body: request.body,
          // @ts-expect-error duplex is required by Node fetch when streaming request bodies
          duplex: 'half',
        });
      } catch {
        return NextResponse.json({
          uploadAssetId: assetId,
          status: 'UPLOADING',
          confirmedBytes: start,
          completed: false,
          retryable: true,
          error: 'GOOGLE_DRIVE_UPLOAD_RETRYABLE',
        }, { status: 503 });
      }

      // 6. Handle Google Drive Resumable protocol response
      const status = googleResponse.status;

      if (status === 308) {
        // Chunk uploaded successfully, but file upload is still incomplete
        const rangeHeader = googleResponse.headers.get('Range');
        let confirmedBytes = start;
        if (rangeHeader) {
          const match = rangeHeader.trim().match(/^bytes=0-(\d+)$/);
          if (match) {
            confirmedBytes = Number(match[1]) + 1;
          }
        }
        return NextResponse.json({
          uploadAssetId: assetId,
          status: 'UPLOADING',
          confirmedBytes,
          completed: false,
          retryable: false,
        }, { status: 200 });
      }

      if (status === 200 || status === 201) {
        // Entire file has been uploaded successfully
        let responseBody = '';
        try {
          responseBody = await googleResponse.text();
        } catch {
          return NextResponse.json({ error: 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE' }, { status: 502 });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(responseBody);
        } catch {
          return NextResponse.json({ error: 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE' }, { status: 502 });
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return NextResponse.json({ error: 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE' }, { status: 502 });
        }

        const driveFileId = (parsed as { id?: unknown }).id;
        if (typeof driveFileId !== 'string' || driveFileId.trim() === '') {
          return NextResponse.json({ error: 'GOOGLE_DRIVE_INVALID_PROVIDER_RESPONSE' }, { status: 502 });
        }

        // Complete the upload session
        const completeHelper = deps?.completeUpload || GoogleDriveUploadCompletionService.completeUpload;
        const completionResult = await completeHelper(user.id, assetId, {
          driveFileId: driveFileId.trim(),
        });

        return NextResponse.json({
          uploadAssetId: assetId,
          status: completionResult.status,
          confirmedBytes: total,
          completed: true,
          retryable: false,
        }, { status: 200 });
      }

      // Handle retryable status codes
      if (RETRYABLE_STATUSES.includes(status)) {
        return NextResponse.json({
          uploadAssetId: assetId,
          status: 'UPLOADING',
          confirmedBytes: start,
          completed: false,
          retryable: true,
          error: 'GOOGLE_DRIVE_UPLOAD_RETRYABLE',
        }, { status: 503 });
      }

      // Default to terminal error for any other status code
      return NextResponse.json({
        uploadAssetId: assetId,
        status: 'FAILED',
        confirmedBytes: start,
        completed: false,
        retryable: false,
        error: 'UPLOAD_SESSION_RESTART_REQUIRED',
      }, { status: 400 });

    } catch (error) {
      return handleUploadApiError(error);
    }
  };
}

export const PUT = createChunkPutHandler();
