export interface OllamaThumbnailSelectionInput {
  readonly thumbnailMode: "auto" | "custom" | "captured";
  readonly thumbnailSource?: "GEMINI_FRAME" | "MANUAL_FRAME";
  readonly force?: boolean;
}

export function shouldApplyOllamaThumbnail(
  input: OllamaThumbnailSelectionInput,
): boolean {
  if (input.force === true) {
    return true;
  }

  return (
    input.thumbnailMode === "captured" &&
    input.thumbnailSource === "GEMINI_FRAME"
  );
}
