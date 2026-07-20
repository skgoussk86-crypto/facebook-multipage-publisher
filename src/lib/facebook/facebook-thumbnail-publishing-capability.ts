import "server-only";

export const FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED =
  "disabled" as const;

export const FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB =
  "experimental_regular_video_thumb" as const;

export const FACEBOOK_THUMBNAIL_PUBLISHING_EXPERIMENTAL_ACK =
  "I_UNDERSTAND_META_THUMBNAIL_API_IS_UNVERIFIED" as const;

export type FacebookThumbnailPublishingMode =
  | typeof FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED
  | typeof FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB;

export type FacebookThumbnailPublishingCapabilityReason =
  | "DISABLED_BY_DEFAULT"
  | "UNSUPPORTED_MODE"
  | "MISSING_EXPERIMENTAL_ACKNOWLEDGEMENT"
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
}

export function getFacebookThumbnailPublishingCapability(
  environment:
    FacebookThumbnailPublishingEnvironment =
      process.env,
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
    return Object.freeze({
      enabled: false,
      mode:
        FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED,
      regularVideoSupported: false,
      reelSupported: false,
      reason: "DISABLED_BY_DEFAULT",
    });
  }

  if (
    configuredMode !==
    FACEBOOK_THUMBNAIL_PUBLISHING_MODE_EXPERIMENTAL_REGULAR_VIDEO_THUMB
  ) {
    return Object.freeze({
      enabled: false,
      mode:
        FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED,
      regularVideoSupported: false,
      reelSupported: false,
      reason: "UNSUPPORTED_MODE",
    });
  }

  if (
    environment
      .FACEBOOK_VIDEO_THUMBNAIL_PUBLISHING_ACK
      ?.trim() !==
    FACEBOOK_THUMBNAIL_PUBLISHING_EXPERIMENTAL_ACK
  ) {
    return Object.freeze({
      enabled: false,
      mode:
        FACEBOOK_THUMBNAIL_PUBLISHING_MODE_DISABLED,
      regularVideoSupported: false,
      reelSupported: false,
      reason:
        "MISSING_EXPERIMENTAL_ACKNOWLEDGEMENT",
    });
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
