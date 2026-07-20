import "server-only";

export const FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED =
  "disabled" as const;

export const FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB =
  "experimental_regular_video_thumb" as const;

export const FACEBOOK_THUMBNAIL_PUBLISHING_EXPERIMENTAL_ACK =
  "I_UNDERSTAND_META_THUMBNAIL_API_IS_UNVERIFIED" as const;

export const FACEBOOK_THUMBNAIL_PUBLISHING_MAX_PROBE_WINDOW_MS =
  15 * 60 * 1000;

export type FacebookThumbnailPublishingMode =
  | typeof FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED
  | typeof FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB;

export type FacebookThumbnailPublishingCapabilityReason =
  | "DISABLED_BY_DEFAULT"
  | "UNSUPPORTED_MODE"
  | "MISSING_EXPERIMENTAL_ACKNOWLEDGEMENT"
  | "MISSING_PROBE_TARGET"
  | "INVALID_PROBE_TARGET"
  | "MISSING_PROBE_CONTEXT"
  | "PROBE_JOB_MISMATCH"
  | "PROBE_PAGE_MISMATCH"
  | "MISSING_PROBE_EXPIRY"
  | "INVALID_PROBE_EXPIRY"
  | "PROBE_WINDOW_EXPIRED"
  | "PROBE_WINDOW_TOO_LONG"
  | "EXPERIMENTAL_REGULAR_VIDEO_THUMB_ENABLED";

export interface FacebookThumbnailPublishingCapability {
  readonly enabled: boolean;
  readonly mode: FacebookThumbnailPublishingMode;
  readonly regularVideoSupported: boolean;
  readonly reelSupported: false;
  readonly reason: FacebookThumbnailPublishingCapabilityReason;
}

export interface FacebookThumbnailPublishingEnvironment {
  readonly [key: string]: string | undefined;
  readonly FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_MODE?:
    string;
  readonly FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_ACK?:
    string;
  readonly FACEBOOK_VIDEO_THUMBNAIL_PROBE_JOB_ID?:
    string;
  readonly FACEBOOK_VIDEO_THUMBNAIL_PROBE_PAGE_ID?:
    string;
  readonly FACEBOOK_VIDEO_THUMBNAIL_PROBE_EXPIRES_AT?:
    string;
}

export interface FacebookThumbnailPublishingProbeContext {
  readonly jobId: string;
  readonly pageId: string;
  readonly now?: Date;
}

function createDisabledCapability(
  reason: FacebookThumbnailPublishingCapabilityReason,
): FacebookThumbnailPublishingCapability {
  return Object.freeze({
    enabled: false,
    mode:
      FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED,
    regularVideoSupported: false,
    reelSupported: false,
    reason,
  });
}

function normalizeProbeIdentifier(
  value: string | undefined,
): string | null {
  const trimmed =
    value?.trim();

  if (
    !trimmed ||
    trimmed.length > 255 ||
    /[\x00-\x1F\x7F]/.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

export function getFacebookThumbnailPublishingCapability(
  environment:
    FacebookThumbnailPublishingEnvironment =
      process.env,
  context?:
    FacebookThumbnailPublishingProbeContext,
): FacebookThumbnailPublishingCapability {
  const configuredMode =
    environment
      .FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_MODE
      ?.trim();

  if (
    !configuredMode ||
    configuredMode ===
      FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED
  ) {
    return createDisabledCapability(
      "DISABLED_BY_DEFAULT",
    );
  }

  if (
    configuredMode !==
    FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB
  ) {
    return createDisabledCapability(
      "UNSUPPORTED_MODE",
    );
  }

  if (
    environment
      .FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_ACK
      ?.trim() !==
    FACEBOOK_THUMBNAIL_PUBLISHING_EXPERIMENTAL_ACK
  ) {
    return createDisabledCapability(
      "MISSING_EXPERIMENTAL_ACKNOWLEDGEMENT",
    );
  }

  const configuredJobId =
    normalizeProbeIdentifier(
      environment
        .FACEBOOK_VIDEO_THUMBNAIL_PROBE_JOB_ID,
    );

  const configuredPageId =
    normalizeProbeIdentifier(
      environment
        .FACEBOOK_VIDEO_THUMBNAIL_PROBE_PAGE_ID,
    );

  if (
    !environment
      .FACEBOOK_VIDEO_THUMBNAIL_PROBE_JOB_ID
      ?.trim() ||
    !environment
      .FACEBOOK_VIDEO_THUMBNAIL_PROBE_PAGE_ID
      ?.trim()
  ) {
    return createDisabledCapability(
      "MISSING_PROBE_TARGET",
    );
  }

  if (
    !configuredJobId ||
    !configuredPageId
  ) {
    return createDisabledCapability(
      "INVALID_PROBE_TARGET",
    );
  }

  if (!context) {
    return createDisabledCapability(
      "MISSING_PROBE_CONTEXT",
    );
  }

  const contextJobId =
    normalizeProbeIdentifier(
      context.jobId,
    );

  const contextPageId =
    normalizeProbeIdentifier(
      context.pageId,
    );

  if (
    !contextJobId ||
    !contextPageId
  ) {
    return createDisabledCapability(
      "MISSING_PROBE_CONTEXT",
    );
  }

  if (
    contextJobId !== configuredJobId
  ) {
    return createDisabledCapability(
      "PROBE_JOB_MISMATCH",
    );
  }

  if (
    contextPageId !== configuredPageId
  ) {
    return createDisabledCapability(
      "PROBE_PAGE_MISMATCH",
    );
  }

  const configuredExpiry =
    environment
      .FACEBOOK_VIDEO_THUMBNAIL_PROBE_EXPIRES_AT
      ?.trim();

  if (!configuredExpiry) {
    return createDisabledCapability(
      "MISSING_PROBE_EXPIRY",
    );
  }

  const expiry =
    new Date(configuredExpiry);

  if (
    Number.isNaN(expiry.getTime())
  ) {
    return createDisabledCapability(
      "INVALID_PROBE_EXPIRY",
    );
  }

  const now =
    context.now
      ? new Date(context.now)
      : new Date();

  if (
    Number.isNaN(now.getTime())
  ) {
    return createDisabledCapability(
      "MISSING_PROBE_CONTEXT",
    );
  }

  const remainingWindowMs =
    expiry.getTime() -
    now.getTime();

  if (remainingWindowMs <= 0) {
    return createDisabledCapability(
      "PROBE_WINDOW_EXPIRED",
    );
  }

  if (
    remainingWindowMs >
    FACEBOOK_THUMBNAIL_PUBLISHING_MAX_PROBE_WINDOW_MS
  ) {
    return createDisabledCapability(
      "PROBE_WINDOW_TOO_LONG",
    );
  }

  return Object.freeze({
    enabled: true,
    mode:
      FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB,
    regularVideoSupported: true,
    reelSupported: false,
    reason:
      "EXPERIMENTAL_REGULAR_VIDEO_THUMB_ENABLED",
  });
}
