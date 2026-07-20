import { z } from "zod";

const hashtagSchema = z
  .string()
  .trim()
  .regex(
    /^#[A-Za-z0-9_]{2,50}$/,
    "Each hashtag must start with # and contain only letters, numbers, or underscores.",
  );

export const geminiVideoOutputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3)
      .max(255)
      .regex(
        /^[^\r\n]+$/,
        "Title must be a single line.",
      ),

    caption: z
      .string()
      .trim()
      .min(10)
      .max(2200),

    hashtags: z
      .array(hashtagSchema)
      .length(
        5,
        "Exactly five hashtags are required.",
      ),

    thumbnailTimestampSeconds: z
      .number()
      .finite()
      .nonnegative(),

    thumbnailReason: z
      .string()
      .trim()
      .min(3)
      .max(300),
  })
  .strict()
  .superRefine((value, context) => {
    const normalizedHashtags =
      value.hashtags.map((hashtag) =>
        hashtag.toLowerCase(),
      );

    if (
      new Set(normalizedHashtags).size !==
      normalizedHashtags.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["hashtags"],
        message:
          "All five hashtags must be unique.",
      });
    }
  });

export type GeminiVideoOutput =
  z.infer<
    typeof geminiVideoOutputSchema
  >;

export const
  GEMINI_VIDEO_OUTPUT_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        description:
          "A catchy, accurate English Facebook video title. Maximum 255 characters and one line only.",
      },
      caption: {
        type: "string",
        description:
          "An accurate, engaging English Facebook caption without fabricated claims.",
      },
      hashtags: {
        type: "array",
        minItems: 5,
        maxItems: 5,
        description:
          "Exactly five unique, relevant English hashtags. Each item must begin with #.",
        items: {
          type: "string",
          pattern:
            "^#[A-Za-z0-9_]{2,50}$",
        },
      },
      thumbnailTimestampSeconds: {
        type: "number",
        minimum: 0,
        description:
          "The video timestamp in seconds containing the strongest clear thumbnail frame.",
      },
      thumbnailReason: {
        type: "string",
        description:
          "A brief explanation of why the selected frame is visually strong.",
      },
    },
    required: [
      "title",
      "caption",
      "hashtags",
      "thumbnailTimestampSeconds",
      "thumbnailReason",
    ],
  } as const;

export function parseGeminiVideoOutput(
  value: unknown,
  durationSeconds: number,
): GeminiVideoOutput {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new Error(
      "A valid positive video duration is required.",
    );
  }

  const parsed =
    geminiVideoOutputSchema.parse(value);

  if (
    parsed.thumbnailTimestampSeconds >
    durationSeconds
  ) {
    throw new Error(
      "Gemini selected a thumbnail timestamp beyond the end of the video.",
    );
  }

  return parsed;
}
