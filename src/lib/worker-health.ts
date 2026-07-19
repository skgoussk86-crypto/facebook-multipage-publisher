import { Prisma } from '@prisma/client';
import { prisma } from './prisma-client';

export function sanitizeErrorMessage(msg: string | null | undefined): string | null {
  if (!msg) return null;
  let sanitized = msg;
  // Redact token/key patterns with optional spaces around equals
  sanitized = sanitized.replace(/(access_token|page_token|refresh_token|token|key|secret|password|bearer|auth|authorization)\s*=\s*[^&\s\.\,]+/ig, '$1=[REDACTED]');
  sanitized = sanitized.replace(/(bearer\s+)[a-zA-Z0-9\-\._\~\+\/]+=*/ig, '$1[REDACTED]');
  // Redact signed URLs and query strings
  sanitized = sanitized.replace(/https?:\/\/[^\s\?]+(\?[^\s]+)/ig, (url) => url.split('?')[0] + '?[REDACTED]');
  // Redact GDrive URIs and file IDs
  sanitized = sanitized.replace(/gdrive:\/\/[a-zA-Z0-9\-_]+/ig, 'gdrive://[REDACTED]');
  sanitized = sanitized.replace(/gcs:\/\/[^\s\/]+/ig, 'gcs://[REDACTED]');
  // Redact postgres database urls
  sanitized = sanitized.replace(/postgresql:\/\/[^@]+@/ig, 'postgresql://[REDACTED]@');
  return sanitized.slice(0, 1000);
}

export async function updateWorkerHeartbeat(params: {
  workerId: string;
  startedAt: Date;
  currentStatus: string;
  success?: boolean;
  jobsProcessed?: number;
  nextPollEstimate?: Date | null;
  lastError?: string | null;
}): Promise<void> {
  const now = new Date();
  const updateData: Prisma.WorkerHeartbeatUpdateInput = {
    lastPingAt: now,
    currentStatus: params.currentStatus,
  };

  if (params.success !== undefined) {
    if (params.success) {
      updateData.lastSuccessAt = now;
      updateData.lastError = null;
    } else {
      updateData.lastFailureAt = now;
    }
  }

  if (params.jobsProcessed !== undefined) {
    updateData.jobsProcessedLastCycle = params.jobsProcessed;
  }

  if (params.nextPollEstimate !== undefined) {
    updateData.nextPollEstimate = params.nextPollEstimate;
  }

  if (params.lastError !== undefined) {
    updateData.lastError = params.lastError === null ? null : sanitizeErrorMessage(params.lastError);
  }

  try {
    await prisma.workerHeartbeat.upsert({
      where: { workerId: params.workerId },
      update: updateData,
      create: {
        workerId: params.workerId,
        startedAt: params.startedAt,
        lastPingAt: now,
        currentStatus: params.currentStatus,
        lastSuccessAt: params.success ? now : null,
        lastFailureAt: params.success === false ? now : null,
        lastError: params.lastError ? sanitizeErrorMessage(params.lastError) : null,
        jobsProcessedLastCycle: params.jobsProcessed || 0,
        nextPollEstimate: params.nextPollEstimate || null,
      },
    });
  } catch (error) {
    console.error(`[WorkerHealth] Failed to write heartbeat for worker ${params.workerId}:`, error);
  }
}
