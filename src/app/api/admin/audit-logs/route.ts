import { NextRequest, NextResponse } from 'next/server';
import { getAuditLogs } from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const logs = await getAuditLogs(user.id, true);
    
    // Format response to match expected frontend structure: { timestampUTC, level, message }
    const formattedLogs = logs.map(log => ({
      timestampUTC: log.createdAt.toISOString(),
      level: 'INFO', // We treat config audit events as INFO levels for display
      message: `[Audit: ${log.action}] ${log.details} ${log.ipAddress ? `(IP: ${log.ipAddress})` : ''}`
    }));

    return NextResponse.json({ logs: formattedLogs });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
