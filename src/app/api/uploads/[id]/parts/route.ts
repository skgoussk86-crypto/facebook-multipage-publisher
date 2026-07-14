import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { prisma } from '@/lib/prisma-client';
import { UploadStatus } from '@prisma/client';
import {
  UploadSessionService,
  UploadStateService,
  handleUploadApiError,
  PART_SIZE_BYTES,
  getStorageAdapter,
} from '@/lib/storage';

export async function handleIssuePartUrl(
  userId: string,
  id: string,
  body: unknown
): Promise<NextResponse> {
  try {
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const { partNumber } = body as { partNumber?: number };
    if (partNumber === undefined || typeof partNumber !== 'number' || !Number.isInteger(partNumber)) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    // 1. Retrieve asset and check ownership
    const asset = await prisma.uploadAsset.findUnique({
      where: { id },
    });

    if (!asset || asset.userId !== userId) {
      return NextResponse.json({ error: 'UPLOAD_NOT_FOUND' }, { status: 404 });
    }

    // Check upload session expiry
    const sessionRecord = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: id },
    });

    if (asset.status === UploadStatus.EXPIRED || !sessionRecord || sessionRecord.expiresAt < new Date()) {
      try {
        await UploadStateService.transitionUploadStatus(userId, id, UploadStatus.EXPIRED);
      } catch {
        // Ignore
      }
      if (sessionRecord) {
        try {
          await prisma.uploadSession.delete({ where: { uploadAssetId: id } });
        } catch {
          // Ignore
        }
      }
      return NextResponse.json({ error: 'UPLOAD_SESSION_EXPIRED' }, { status: 410 });
    }

    if (asset.status !== UploadStatus.UPLOADING) {
      return NextResponse.json({ error: 'INVALID_UPLOAD_STATE' }, { status: 400 });
    }

    // 2. Validate part number bounds
    const totalParts = Math.ceil(Number(asset.expectedSize) / PART_SIZE_BYTES);
    if (partNumber < 1 || partNumber > totalParts) {
      return NextResponse.json({ error: 'INVALID_PART_NUMBER' }, { status: 400 });
    }

    // 3. Retrieve decrypted session
    const session = await UploadSessionService.getDecryptedSession(userId, id);

    // 4. Generate presigned part upload URL
    const adapter = getStorageAdapter();
    const uploadUrl = await adapter.createPresignedUploadPartUrl(
      asset.bucket,
      asset.objectKey,
      session.providerSessionId,
      partNumber,
      900 // 15 mins TTL
    );

    // 5. Update session activity
    await prisma.uploadSession.update({
      where: { uploadAssetId: id },
      data: {
        lastActivityAt: new Date(),
      },
    });

    // 6. Log URL issuance in audits (omit secrets / credentials)
    await prisma.auditLog.create({
      data: {
        action: 'UPLOAD_PART_URL_ISSUED',
        details: `Issued presigned upload URL for asset ${id}, part number ${partNumber}.`,
        userId,
      },
    });

    return NextResponse.json({
      assetId: id,
      partNumber,
      uploadUrl,
      expiresInSeconds: 900,
    }, { status: 200 });
  } catch (err) {
    return handleUploadApiError(err);
  }
}

export async function handleRecordPart(
  userId: string,
  id: string,
  body: unknown
): Promise<NextResponse> {
  try {
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const { partNumber, etag } = body as { partNumber?: number; etag?: string };
    if (partNumber === undefined || typeof partNumber !== 'number' || !Number.isInteger(partNumber)) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    if (!etag || typeof etag !== 'string' || etag.trim().length === 0) {
      return NextResponse.json({ error: 'INVALID_ETAG' }, { status: 400 });
    }

    // 1. Retrieve asset and check ownership
    const asset = await prisma.uploadAsset.findUnique({
      where: { id },
    });

    if (!asset || asset.userId !== userId) {
      return NextResponse.json({ error: 'UPLOAD_NOT_FOUND' }, { status: 404 });
    }

    // Check upload session expiry
    const sessionRecord = await prisma.uploadSession.findUnique({
      where: { uploadAssetId: id },
    });

    if (asset.status === UploadStatus.EXPIRED || !sessionRecord || sessionRecord.expiresAt < new Date()) {
      try {
        await UploadStateService.transitionUploadStatus(userId, id, UploadStatus.EXPIRED);
      } catch {
        // Ignore
      }
      if (sessionRecord) {
        try {
          await prisma.uploadSession.delete({ where: { uploadAssetId: id } });
        } catch {
          // Ignore
        }
      }
      return NextResponse.json({ error: 'UPLOAD_SESSION_EXPIRED' }, { status: 410 });
    }

    if (asset.status !== UploadStatus.UPLOADING) {
      return NextResponse.json({ error: 'INVALID_UPLOAD_STATE' }, { status: 400 });
    }

    // 2. Validate part number bounds
    const totalParts = Math.ceil(Number(asset.expectedSize) / PART_SIZE_BYTES);
    if (partNumber < 1 || partNumber > totalParts) {
      return NextResponse.json({ error: 'INVALID_PART_NUMBER' }, { status: 400 });
    }

    // 3. Compute part size
    let size = PART_SIZE_BYTES;
    if (partNumber === totalParts) {
      const remainder = Number(asset.expectedSize) % PART_SIZE_BYTES;
      size = remainder === 0 ? PART_SIZE_BYTES : remainder;
    }

    // 4. Update completed parts mapping
    const updatedSession = await UploadSessionService.updateCompletedParts(userId, id, [
      { partNumber, etag, size },
    ]);

    const completedPartNumbers = updatedSession.completedParts.map((p) => p.partNumber);

    // 5. Log part completion in audits (omit secrets / ETags)
    await prisma.auditLog.create({
      data: {
        action: 'UPLOAD_PART_RECORDED',
        details: `Recorded completed part ${partNumber} for asset ${id}.`,
        userId,
      },
    });

    return NextResponse.json({
      assetId: id,
      recordedPartNumber: partNumber,
      completedPartNumbers,
      completedPartCount: completedPartNumbers.length,
      totalParts,
    }, { status: 200 });
  } catch (err) {
    return handleUploadApiError(err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    return await handleIssuePartUrl(user.id, id, body);
  } catch (err) {
    return handleUploadApiError(err);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    return await handleRecordPart(user.id, id, body);
  } catch (err) {
    return handleUploadApiError(err);
  }
}
