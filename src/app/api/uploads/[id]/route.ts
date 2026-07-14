import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma-client';
import { UploadStatus } from '@prisma/client';
import {
  UploadSessionService,
  UploadStateService,
  handleUploadApiError,
  serializeBigInt,
  PART_SIZE_BYTES,
  ExpiredSessionError,
} from '@/lib/storage';

interface SerializedAsset {
  id: string;
  originalName: string;
  expectedSize: string;
  declaredMimeType: string;
  status: string;
  uploadExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export async function handleGetUploadStatus(
  userId: string,
  id: string
): Promise<NextResponse> {
  try {
    // 1. Retrieve asset and check ownership
    const asset = await prisma.uploadAsset.findUnique({
      where: { id },
    });

    if (!asset || asset.userId !== userId) {
      return NextResponse.json({ error: 'UPLOAD_NOT_FOUND' }, { status: 404 });
    }

    let completedPartNumbers: number[] = [];
    let lastActivityAt = asset.updatedAt;

    // 2. Fetch session details if active
    if (asset.status === UploadStatus.UPLOADING || asset.status === UploadStatus.REQUESTED) {
      try {
        const session = await UploadSessionService.getDecryptedSession(userId, id);
        completedPartNumbers = session.completedParts.map((p) => p.partNumber);
        lastActivityAt = session.lastActivityAt;
      } catch (err) {
        if (err instanceof ExpiredSessionError) {
          try {
            await UploadStateService.transitionUploadStatus(userId, id, UploadStatus.EXPIRED);
          } catch {
            // Ignore if state transition is not allowed
          }
          return NextResponse.json({ error: 'UPLOAD_SESSION_EXPIRED' }, { status: 410 });
        }
        // If not found or another error, default to empty list
      }
    }

    const totalParts = Math.ceil(Number(asset.expectedSize) / PART_SIZE_BYTES);
    const serializedAsset = serializeBigInt(asset) as SerializedAsset;

    const safeResponse = {
      assetId: serializedAsset.id,
      filename: serializedAsset.originalName,
      expectedSize: serializedAsset.expectedSize,
      declaredMimeType: serializedAsset.declaredMimeType,
      status: serializedAsset.status,
      partSize: PART_SIZE_BYTES,
      totalParts,
      completedPartNumbers,
      uploadExpiresAt: serializedAsset.uploadExpiresAt,
      lastActivityAt,
      createdAt: serializedAsset.createdAt,
      updatedAt: serializedAsset.updatedAt,
    };

    return NextResponse.json(safeResponse, { status: 200 });
  } catch (err) {
    return handleUploadApiError(err);
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }

    return await handleGetUploadStatus(user.id, id);
  } catch (err) {
    return handleUploadApiError(err);
  }
}
