import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { UploadFinalizationService, handleUploadApiError } from '@/lib/storage';

export async function handleAbortUpload(
  userId: string,
  id: string
): Promise<NextResponse> {
  try {
    const result = await UploadFinalizationService.abortUpload(userId, id);
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
