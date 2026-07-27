import { z } from "zod";

export type AiProvider = "OLLAMA" | "GEMINI";

export const hashtagSchema = z
  .string()
  .trim()
  .regex(
    /^#[A-Za-z0-9_]{2,50}$/,
    "Each hashtag must start with # and contain only letters, numbers, or underscores (length 2-50)."
  );

export const generatedVideoContentSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Title must be at least 3 characters.")
      .max(255, "Title must not exceed 255 characters.")
      .regex(/^[^\r\n]+$/, "Title must be a single line."),

    caption: z
      .string()
      .trim()
      .min(10, "Caption must be at least 10 characters.")
      .max(2200, "Caption must not exceed 2200 characters."),

    hashtags: z
      .array(hashtagSchema)
      .length(5, "Exactly five hashtags are required."),

    thumbnailTimestampSeconds: z
      .number()
      .finite()
      .nonnegative("Timestamp must be non-negative."),

    confidence: z.number().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // Unique check after case-insensitive normalization
    const normalized = value.hashtags.map((h) => h.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hashtags"],
        message: "All five hashtags must be unique (case-insensitive).",
      });
    }
  });

export type GeneratedVideoContent = z.infer<typeof generatedVideoContentSchema>;

export type AiVideoAnalysisErrorCode =
  | "AI_DISABLED"
  | "AI_NOT_CONFIGURED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_TIMEOUT"
  | "AI_BUSY"
  | "AI_INVALID_RESPONSE"
  | "AI_ANALYSIS_FAILED"
  | "UPLOAD_ASSET_NOT_FOUND"
  | "UPLOAD_ASSET_NOT_VALIDATED"
  | "UPLOAD_ASSET_DELETED"
  | "UNSUPPORTED_STORAGE_PROVIDER"
  | "INVALID_VIDEO_METADATA"
  | "INVALID_IMAGE_METADATA"
  | "VIDEO_TOO_LARGE"
  | "VIDEO_DOWNLOAD_FAILED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_DOWNLOAD_FAILED";

export class AiVideoAnalysisError extends Error {
  constructor(
    public readonly code: AiVideoAnalysisErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AiVideoAnalysisError";
  }
}
