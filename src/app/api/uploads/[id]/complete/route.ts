import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/lib/auth';
import { UploadFinalizationService, handleUploadApiError } from '@/lib/storage';

export async function handleCompleteUpload(
  userId: string,
  id: string,
  body: unknown
): Promise<NextResponse> {
  try {
    const result = await UploadFinalizationService.completeUpload(userId, id, body);
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
