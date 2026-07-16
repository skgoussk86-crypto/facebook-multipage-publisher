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

export async function handleAbortUpload(
  userId: string,
  id: string,
  deps?: {
    findUploadAsset?: (id: string) => Promise<{ provider: string; userId: string } | null>;
    abortGDUpload?: typeof GoogleDriveUploadCompletionService.abortUpload;
    abortR2Upload?: typeof UploadFinalizationService.abortUpload;
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
      const gdHelper = deps?.abortGDUpload || GoogleDriveUploadCompletionService.abortUpload;
      const gdResult = await gdHelper(userId, id);
      return NextResponse.json(gdResult, { status: 200 });
    }

    const r2Helper = deps?.abortR2Upload || UploadFinalizationService.abortUpload;
    const result = await r2Helper(userId, id);
    return NextResponse.json(result, { status: 200 });
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

    return await handleAbortUpload(user.id, id);
  } catch (err) {
    return handleUploadApiError(err);
  }
}
