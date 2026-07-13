import { NextRequest, NextResponse } from 'next/server';
import {
  createAuditLog,
  getAppConfiguration
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

    const secretIsMaskedOrEmpty =
      !facebookAppSecret.trim() ||
      isMaskedSecret(facebookAppSecret);

    let secretToTest: string;

    if (secretIsMaskedOrEmpty) {
      const existingConfiguration =
        await getAppConfiguration(user.id);

      if (!existingConfiguration) {
        return validationError(
          'No existing personal configuration was found. Enter a valid Facebook App Secret.'
        );
      }

      try {
        secretToTest = decryptToken(
          existingConfiguration.encryptedAppSecret
        );
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        await createAuditLog(
          'TEST_CONFIG',
          `Personal Meta configuration validation failed because the stored App Secret could not be decrypted: ${message}`,
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
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        return validationError(
          `Facebook App Secret encryption test failed: ${message}`
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
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      'Error testing Meta configuration:',
      error
    );

    return NextResponse.json(
      {
        success: false,
        message:
          `Internal configuration validation error: ${message}`
      },
      {
        status: 500
      }
    );
  }
}