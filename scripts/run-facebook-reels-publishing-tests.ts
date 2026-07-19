import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  FacebookPublishingService,
} from '../src/lib/facebook/facebook-publishing-service';

type CapturedRequest = {
  url: string;
  init?: RequestInit & {
    duplex?: string;
  };
};

const originalFetch = globalThis.fetch;

async function main(): Promise<void> {
  const captured: CapturedRequest[] = [];

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      input instanceof Request
        ? input.url
        : input.toString();

    captured.push({
      url,
      init: init as RequestInit & {
        duplex?: string;
      },
    });

    if (url.includes('/me/video_reels')) {
      const parsed = new URL(url);

      if (
        parsed.searchParams.get(
          'upload_phase',
        ) === 'start'
      ) {
        return new Response(
          JSON.stringify({
            video_id: 'video-123',
            upload_url:
              'https://rupload.facebook.com/video-upload/v20.0/video-123',
          }),
          {
            status: 200,
            headers: {
              'Content-Type':
                'application/json',
            },
          },
        );
      }

      if (
        parsed.searchParams.get(
          'upload_phase',
        ) === 'finish'
      ) {
        return new Response(
          JSON.stringify({
            success: true,
          }),
          {
            status: 200,
            headers: {
              'Content-Type':
                'application/json',
            },
          },
        );
      }
    }

    if (
      url.startsWith(
        'https://rupload.facebook.com/',
      )
    ) {
      return new Response(
        JSON.stringify({
          success: true,
        }),
        {
          status: 200,
          headers: {
            'Content-Type':
              'application/json',
          },
        },
      );
    }

    throw new Error(
      `Unexpected test URL: ${url}`,
    );
  }) as typeof fetch;

  const start =
    await FacebookPublishingService.startReelUploadSession(
      'page-token',
    );

  assert.equal(
    start.videoId,
    'video-123',
  );

  assert.equal(
    start.uploadUrl,
    'https://rupload.facebook.com/video-upload/v20.0/video-123',
  );

  const startRequest = captured[0];
  const startUrl = new URL(
    startRequest.url,
  );

  assert.equal(
    startUrl.pathname,
    '/v20.0/me/video_reels',
  );

  assert.equal(
    startUrl.searchParams.get(
      'upload_phase',
    ),
    'start',
  );

  assert.equal(
    startUrl.searchParams.get(
      'access_token',
    ),
    'page-token',
  );

  await FacebookPublishingService.uploadReelMedia(
    start.uploadUrl,
    'page-token',
    5,
    Readable.from([Buffer.from('hello')]),
  );

  const uploadRequest = captured[1];

  assert.equal(
    uploadRequest.url,
    start.uploadUrl,
  );

  const uploadHeaders = new Headers(
    uploadRequest.init?.headers,
  );

  assert.equal(
    uploadHeaders.get('Authorization'),
    'OAuth page-token',
  );

  assert.equal(
    uploadHeaders.get('offset'),
    '0',
  );

  assert.equal(
    uploadHeaders.get('file_size'),
    '5',
  );

  assert.equal(
    uploadHeaders.get('Content-Type'),
    'application/octet-stream',
  );

  assert.equal(
    uploadRequest.init?.duplex,
    'half',
  );

  await FacebookPublishingService.finishReelUploadSession(
    'page-token',
    'video-123',
    'Test title',
    'Test caption',
    '#One #Two',
  );

  const finishRequest = captured[2];
  const finishUrl = new URL(
    finishRequest.url,
  );

  assert.equal(
    finishUrl.pathname,
    '/v20.0/me/video_reels',
  );

  assert.equal(
    finishUrl.searchParams.get(
      'upload_phase',
    ),
    'finish',
  );

  assert.equal(
    finishUrl.searchParams.get(
      'video_state',
    ),
    'PUBLISHED',
  );

  assert.equal(
    finishUrl.searchParams.get(
      'video_id',
    ),
    'video-123',
  );

  assert.equal(
    finishUrl.searchParams.get(
      'description',
    ),
    'Test caption\n\n#One #Two',
  );

  let rejectedUntrustedHost = false;

  try {
    await FacebookPublishingService.uploadReelMedia(
      'https://example.com/upload',
      'page-token',
      5,
      Readable.from([
        Buffer.from('hello'),
      ]),
    );
  } catch (error: unknown) {
    rejectedUntrustedHost = true;

    assert.match(
      error instanceof Error
        ? error.message
        : String(error),
      /untrusted Reel upload host/,
    );
  }

  assert.equal(
    rejectedUntrustedHost,
    true,
  );

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message:
            'Temporary Meta failure',
          code: 1,
          error_subcode: 99,
          is_transient: true,
          fbtrace_id: 'trace-abc',
        },
      }),
      {
        status: 500,
        headers: {
          'Content-Type':
            'application/json',
        },
      },
    )) as typeof fetch;

  let detailedErrorCaptured = false;

  try {
    await FacebookPublishingService.startReelUploadSession(
      'page-token',
    );
  } catch (error: unknown) {
    detailedErrorCaptured = true;

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    assert.match(
      message,
      /META_API_ERROR/,
    );

    assert.match(
      message,
      /Status: 500/,
    );

    assert.match(
      message,
      /Code: 1/,
    );

    assert.match(
      message,
      /Subcode: 99/,
    );

    assert.match(
      message,
      /Transient: true/,
    );

    assert.match(
      message,
      /FBTrace: trace-abc/,
    );
  }

  assert.equal(
    detailedErrorCaptured,
    true,
  );

  console.log(
    'FACEBOOK_REELS_PUBLISHING_TESTS=PASSED',
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      'FACEBOOK_REELS_PUBLISHING_TESTS=FAILED',
    );

    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );

    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
  });
