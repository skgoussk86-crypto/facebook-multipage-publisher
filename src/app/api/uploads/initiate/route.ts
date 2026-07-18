import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import {
  UploadInitiationService,
  handleUploadApiError,
  PART_SIZE_BYTES,
} from '@/lib/storage';
import { getActiveConnectionForOwner } from '@/lib/google-drive/google-drive-connection-repository';
import { GoogleDriveUploadInitiationService } from '@/lib/google-drive/google-drive-upload-initiation-service';

export async function handleInitiateUpload(
  userId: string,
  idempotencyKey: string | null,
  body: unknown,
  deps?: {
    getActiveConnection?: typeof getActiveConnectionForOwner;
    initiateGDUpload?: typeof GoogleDriveUploadInitiationService.initiateGDUpload;
    initiateR2Upload?: typeof UploadInitiationService.initiateFlow;
  }
): Promise<NextResponse> {
  try {
    if (!idempotencyKey || idempotencyKey.trim().length === 0 || idempotencyKey.length > 128) {
      return NextResponse.json({ error: 'INVALID_IDEMPOTENCY_KEY' }, { status: 400 });
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const { filename, expectedSize, declaredMimeType } = body as { filename?: string; expectedSize?: unknown; declaredMimeType?: string };
    if (!filename || typeof filename !== 'string' || expectedSize === undefined || !declaredMimeType || typeof declaredMimeType !== 'string') {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    let expectedSizeBigInt: bigint;
    try {
      expectedSizeBigInt = BigInt(expectedSize as string | number | bigint);
    } catch {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const connHelper = deps?.getActiveConnection || getActiveConnectionForOwner;
    const connection = await connHelper(userId);
    const hasGoogleDrive = !!(
      connection &&
      connection.revokedAt === null &&
      connection.driveFolderId &&
      connection.driveFolderId.trim() !== ""
    );

    if (hasGoogleDrive) {
      const gdHelper = deps?.initiateGDUpload || GoogleDriveUploadInitiationService.initiateGDUpload;
      const gdResult = await gdHelper(userId, {
        idempotencyKey,
        originalName: filename,
        expectedSize: expectedSizeBigInt,
        declaredMimeType,
      });

      const safeResponse = {
        provider: 'GOOGLE_DRIVE',
        assetId: gdResult.assetId,
        filename: gdResult.filename,
        mimeType: gdResult.mimeType,
        totalBytes: gdResult.totalBytes.toString(),
        idempotentReplay: gdResult.idempotentReplay,
      };

      const status = gdResult.idempotentReplay ? 200 : 201;
      return NextResponse.json(safeResponse, { status });
    }

    const initiateR2 = deps?.initiateR2Upload ?? UploadInitiationService.initiateFlow;
    const result = await initiateR2(userId, {
      idempotencyKey,
      originalName: filename,
      expectedSize: expectedSizeBigInt,
      declaredMimeType,
    });

    interface SerializedAsset {
      id: string;
      originalName: string;
      expectedSize: string;
      declaredMimeType: string;
      status: string;
      uploadExpiresAt: string;
      createdAt: string;
    }

    const asset = result.asset as SerializedAsset;
    const totalParts = Math.ceil(Number(asset.expectedSize) / PART_SIZE_BYTES);

    const safeResponse = {
      provider: 'R2',
      assetId: asset.id,
      filename: asset.originalName,
      expectedSize: asset.expectedSize,
      declaredMimeType: asset.declaredMimeType,
      status: asset.status,
      partSize: PART_SIZE_BYTES,
      totalParts,
      uploadExpiresAt: asset.uploadExpiresAt,
      createdAt: asset.createdAt,
      idempotentReplay: result.idempotentReplay,
    };

    const status = result.idempotentReplay ? 200 : 201;
    return NextResponse.json(safeResponse, { status });
  } catch (err) {
    return handleUploadApiError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }

    const idempotencyKey = request.headers.get('idempotency-key');
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    return await handleInitiateUpload(user.id, idempotencyKey, body);
  } catch (err) {
    return handleUploadApiError(err);
  }
}
