import { NextRequest, NextResponse } from 'next/server';
import {
  createAuditLog,
  getAppConfigurationById
} from '@/lib/db';
import { verifyAdminSession } from '@/lib/auth';
import {
  decryptToken,
  encryptToken
} from '@/lib/crypto';

const FACEBOOK_SECRET_MASK = '************';
const REAL_BULLET_CHARACTER = '\u2022';
const LEGACY_BROKEN_BULLET = '\u00e2\u20ac\u00a2';

interface ConfigurationTestBody {
  publicAppUrl?: unknown;
  facebookAppId?: unknown;
  facebookAppSecret?: unknown;
  liveMetaMode?: unknown;
  configurationId?: unknown;
}

function getRequestIp(request: NextRequest): string | null {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers
      .get('x-forwarded-for')
      ?.split(',')[0]
      ?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  );
}

function isRepeatedMask(
  value: string,
  maskCharacter: string
): boolean {
  if (!value || !maskCharacter) {
    return false;
  }

  return (
    value.split(maskCharacter).join('') === ''
  );
}

function isMaskedSecret(value: string): boolean {
  const trimmedValue = value.trim();

  if (trimmedValue === FACEBOOK_SECRET_MASK) {
    return true;
  }

  if (
    isRepeatedMask(
      trimmedValue,
      REAL_BULLET_CHARACTER
    )
  ) {
    return true;
  }

  return isRepeatedMask(
    trimmedValue,
    LEGACY_BROKEN_BULLET
  );
}

function validationError(message: string) {
  return NextResponse.json(
    {
      success: false,
      message: `Validation failed: ${message}`
    },
    {
      status: 400
    }
  );
}

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAdminSession(request);

    if (!user) {
      return NextResponse.json(
        {
          success: false,
          message: 'Unauthorized'
        },
        {
          status: 401
        }
      );
    }

    const body =
      (await request.json()) as ConfigurationTestBody;

    const publicAppUrl =
      typeof body.publicAppUrl === 'string'
        ? body.publicAppUrl.trim()
        : '';

    const facebookAppId =
      typeof body.facebookAppId === 'string'
        ? body.facebookAppId.trim()
        : '';

    const facebookAppSecret =
      typeof body.facebookAppSecret === 'string'
        ? body.facebookAppSecret
        : '';

    const liveMetaMode =
      body.liveMetaMode === true;

    if (!facebookAppId) {
      return validationError(
        'Facebook App ID is required.'
      );
    }

    if (facebookAppId.length > 255) {
      return validationError(
        'Facebook App ID must not exceed 255 characters.'
      );
    }

    if (!publicAppUrl) {
      return validationError(
        'Public App URL is required.'
      );
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(publicAppUrl);
    } catch {
      return validationError(
        'Invalid Public App URL format.'
      );
    }

    if (
      parsedUrl.protocol !== 'http:' &&
      parsedUrl.protocol !== 'https:'
    ) {
      return validationError(
        'Public App URL must use http:// or https://.'
      );
    }

    if (
      liveMetaMode &&
      parsedUrl.protocol !== 'https:'
    ) {
      return validationError(
        'Public App URL must use HTTPS in Live Meta Mode.'
      );
    }

    if (parsedUrl.username || parsedUrl.password) {
      return validationError(
        'Public App URL must not contain embedded credentials.'
      );
    }

    const cleanPathname =
      parsedUrl.pathname.replace(/\/+$/, '');

    if (cleanPathname !== '') {
      return validationError(
        `Public App URL must be a base URL without subpaths (found subpath: ${parsedUrl.pathname}).`
      );
    }

    if (parsedUrl.search || parsedUrl.hash) {
      return validationError(
        'Public App URL must not contain query parameters or fragments.'
      );
    }

    const sanitizedUrl = parsedUrl.origin;

    // 1. ALWAYS VALIDATE EXPLICIT CONFIGURATION OWNERSHIP
    const bodyHasConfigId = body.configurationId !== undefined;
    const queryHasConfigId = request.nextUrl.searchParams.has('configurationId');

    let existingConfiguration: Awaited<ReturnType<typeof getAppConfigurationById>> = null;

    if (bodyHasConfigId || queryHasConfigId) {
      const rawConfigId = bodyHasConfigId ? body.configurationId : request.nextUrl.searchParams.get('configurationId');

      if (typeof rawConfigId !== 'string') {
        return validationError('Invalid configuration ID.');
      }

      const trimmed = rawConfigId.trim();
      if (!trimmed || trimmed === 'new') {
        return validationError('Invalid configuration ID.');
      }

      // Resolve it immediately
      existingConfiguration = await getAppConfigurationById(user.id, trimmed);
      if (!existingConfiguration) {
        return validationError('App configuration not found or access denied.');
      }
    }

    const secretIsMaskedOrEmpty =
      !facebookAppSecret.trim() ||
      isMaskedSecret(facebookAppSecret);

    let secretToTest: string;

    if (secretIsMaskedOrEmpty) {
      // For a new unsaved configuration, Validate Configuration must require a newly entered nonblank App Secret.
      if (!existingConfiguration) {
        return NextResponse.json(
          {
            success: false,
            message: 'Enter a Facebook App Secret for the new configuration.'
          },
          {
            status: 400
          }
        );
      }

      // 2. PREVENT APP-ID/SECRET MISMATCH DURING MASKED VALIDATION
      if (facebookAppId !== existingConfiguration.facebookAppId) {
        return NextResponse.json(
          {
            success: false,
            message: 'Enter the App Secret that belongs to the changed Facebook App ID.'
          },
          {
            status: 400
          }
        );
      }

      try {
        secretToTest = decryptToken(
          existingConfiguration.encryptedAppSecret
        );
      } catch {
        // Do not place decryption exception details in audit logs.
        await createAuditLog(
          'TEST_CONFIG',
          'Personal Meta configuration validation failed because the stored App Secret could not be decrypted.',
          getRequestIp(request),
          user.id
        );

        return validationError(
          'The saved Facebook App Secret could not be decrypted. Enter and save the App Secret again.'
        );
      }
    } else {
      const cleanSecret =
        facebookAppSecret.trim();

      if (cleanSecret.length > 1000) {
        return validationError(
          'Facebook App Secret must not exceed 1000 characters.'
        );
      }

      try {
        const encryptedSecret =
          encryptToken(cleanSecret);

        secretToTest = decryptToken(
          encryptedSecret
        );
      } catch {
        return validationError(
          'Facebook App Secret encryption test failed.'
        );
      }

      if (secretToTest !== cleanSecret) {
        return validationError(
          'Facebook App Secret encryption verification did not match.'
        );
      }
    }

    if (!secretToTest.trim()) {
      return validationError(
        'Facebook App Secret is empty.'
      );
    }

    const callbackUrl =
      `${sanitizedUrl}/api/auth/facebook/callback`;

    const modeLabel = liveMetaMode
      ? 'Live'
      : 'Mock';

    await createAuditLog(
      'TEST_CONFIG',
      `Personal Meta configuration local validation completed successfully (Mode: ${modeLabel}, App ID: ${facebookAppId})`,
      getRequestIp(request),
      user.id
    );

    return NextResponse.json({
      success: true,
      message:
        'Local configuration validation completed successfully.',
      details: {
        facebookAppId,
        publicAppUrl: sanitizedUrl,
        callbackUrl,
        liveMetaMode
      }
    });
  } catch {
    console.error('Error testing Meta configuration');

    return NextResponse.json(
      {
        success: false,
        message: 'Unable to validate the Meta App configuration.'
      },
      {
        status: 500
      }
    );
  }
}