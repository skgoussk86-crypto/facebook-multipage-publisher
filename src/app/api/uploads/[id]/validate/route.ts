import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { VideoValidationService } from '@/lib/storage/video-validation-service';
import { handleUploadApiError } from '@/lib/storage';

import { prepareValidationSource } from '@/lib/storage/validation-source-resolver';

export async function handleValidateUpload(
  userId: string,
  id: string,
  deps?: {
    validateAssetById?: typeof VideoValidationService.validateAssetById;
    prepareValidationSource?: typeof prepareValidationSource;
  }
): Promise<NextResponse> {
  try {
    const validateFn = deps?.validateAssetById ?? ((userId, assetId, validationDeps) => VideoValidationService.validateAssetById(userId, assetId, validationDeps));
    const result = await validateFn(userId, id, { prepareValidationSource: deps?.prepareValidationSource });
    
    const responseBody = {
      status: result.status,
      durationMs: result.durationMs ?? null,
      width: result.width ?? null,
      height: result.height ?? null,
      frameRate: result.frameRate ?? null,
      videoCodec: result.videoCodec ?? null,
      audioCodec: result.audioCodec ?? null,
      containerFormat: result.containerFormat ?? null,
      detectedMimeType: result.detectedMimeType ?? null,
      failureCode: result.failureCode,
      failureMessage: result.failureMessage,
    };
    return NextResponse.json(responseBody, { status: 200 });
  } catch (err) {
    return handleUploadApiError(err);
  }
}

export async function handleValidateUploadRequest(
  request: NextRequest,
  params: { id: string },
  deps?: {
    verifyAdminSession?: typeof verifyAdminSession;
    validateAssetById?: typeof VideoValidationService.validateAssetById;
    prepareValidationSource?: typeof prepareValidationSource;
  }
): Promise<NextResponse> {
  try {
    const verifySessionFn = deps?.verifyAdminSession || verifyAdminSession;
    const user = await verifySessionFn(request);
    if (!user) {
      return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    }

    return await handleValidateUpload(user.id, params.id, deps);
  } catch (err) {
    return handleUploadApiError(err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const resolvedParams = await params;
  return handleValidateUploadRequest(request, resolvedParams);
}
