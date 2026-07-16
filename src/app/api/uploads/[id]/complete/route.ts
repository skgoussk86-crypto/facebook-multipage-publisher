import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { GoogleDriveUploadCompletionService } from '@/lib/google-drive/google-drive-upload-completion-service';
import { prisma as defaultPrisma } from '@/lib/prisma-client';
import {
  UploadFinalizationService,
  handleUploadApiError,
  NotFoundError,
  ForbiddenOwnershipError,
} from '@/lib/storage';

export async function handleCompleteUpload(
  userId: string,
  id: string,
  body: unknown,
  deps?: {
    findUploadAsset?: (id: string) => Promise<{ provider: string; userId: string } | null>;
    completeGDUpload?: typeof GoogleDriveUploadCompletionService.completeUpload;
    completeR2Upload?: typeof UploadFinalizationService.completeUpload;
  }
): Promise<NextResponse> {
  try {
    const findAssetFn = deps?.findUploadAsset || (async (assetId) => {
      return await defaultPrisma.uploadAsset.findUnique({ where: { id: assetId } });
    });
    const asset = await findAssetFn(id);
    if (!asset) {
      throw new NotFoundError('Upload asset not found.');
    }
    if (asset.userId !== userId) {
      throw new ForbiddenOwnershipError('Access denied: You do not own this upload asset.');
    }

    if (asset.provider === 'GOOGLE_DRIVE') {
      const gdHelper = deps?.completeGDUpload || GoogleDriveUploadCompletionService.completeUpload;
      const gdResult = await gdHelper(userId, id, body);
      return NextResponse.json(gdResult, { status: 200 });
    }

    const r2Helper = deps?.completeR2Upload || UploadFinalizationService.completeUpload;
    const result = await r2Helper(userId, id, body);
    return NextResponse.json(result, { status: 202 });
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

    return await handleCompleteUpload(user.id, id, body);
  } catch (err) {
    return handleUploadApiError(err);
  }
}
