import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { GoogleDriveUploadReconciliationService } from '@/lib/google-drive/google-drive-upload-reconciliation-service';
import { handleUploadApiError } from '@/lib/storage';

export async function handleReconcileUpload(
  userId: string,
  id: string,
  deps?: {
    reconcileUpload?: typeof GoogleDriveUploadReconciliationService.reconcileUpload;
  }
): Promise<NextResponse> {
  try {
    const reconcileFn = deps?.reconcileUpload || GoogleDriveUploadReconciliationService.reconcileUpload;
    const result = await reconcileFn(userId, id);
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

    return await handleReconcileUpload(user.id, id);
  } catch (err) {
    return handleUploadApiError(err);
  }
}
