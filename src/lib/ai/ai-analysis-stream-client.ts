export interface AnalysisStreamCallbacks {
  onReady?: (status: unknown) => void;
  onResult?: (result: unknown) => void;
  onError?: (error: unknown) => void;
}

export class AnalysisRequestRegistry {
  private registry: Record<string, AbortController> = {};

  register(jobId: string, controller: AbortController): boolean {
    if (this.registry[jobId]) {
      return false;
    }
    this.registry[jobId] = controller;
    return true;
  }

  release(jobId: string, controller: AbortController): void {
    if (this.registry[jobId] === controller) {
      delete this.registry[jobId];
    }
  }

  has(jobId: string): boolean {
    return !!this.registry[jobId];
  }
}

export function validateStreamResponseContentType(response: Response): void {
  const contentType = response.headers.get("content-type") || "";
  const normalized = contentType.toLowerCase().trim();
  if (!normalized.startsWith("text/event-stream")) {
    throw new Error("The AI analysis connection ended before completion. Please try again.");
  }
}

export async function parseAnalysisStream(
  response: Response,
  callbacks: AnalysisStreamCallbacks
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body reader is not available.");
  }

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let currentEventName = "";
  let currentDataLines: string[] = [];
  let eventDispatched = false;

  const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MB limit to prevent memory leak
  const MAX_EVENT_SIZE = 1024 * 1024;  // 1 MB limit for single accumulated event

  let accumulatedEventSize = 0;
  let hasError = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const decodedChunk = decoder.decode(value, { stream: true });
      buffer += decodedChunk;

      if (buffer.length > MAX_BUFFER_SIZE) {
        throw new Error("Stream event size exceeded limit.");
      }

      let lineEndIndex: number;
      while ((lineEndIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, lineEndIndex);
        buffer = buffer.slice(lineEndIndex + 1);

        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        // Count line size including the newline character
        accumulatedEventSize += rawLine.length + 1;
        if (accumulatedEventSize > MAX_EVENT_SIZE) {
          throw new Error("Stream event size exceeded limit.");
        }

        if (line === "") {
          if (currentEventName || currentDataLines.length > 0) {
            const dataStr = currentDataLines.join("\n");

            let parsedData: unknown = null;
            if (dataStr) {
              try {
                parsedData = JSON.parse(dataStr);
              } catch {
                throw new Error("Malformed JSON in stream data.");
              }
            }

            if (currentEventName === "ready") {
              callbacks.onReady?.(parsedData);
            } else if (currentEventName === "result") {
              callbacks.onResult?.(parsedData);
              eventDispatched = true;
            } else if (currentEventName === "error") {
              callbacks.onError?.(parsedData);
              eventDispatched = true;
            }

            currentEventName = "";
            currentDataLines = [];
          }
          // Reset accumulated event size on blank-line boundaries
          accumulatedEventSize = 0;
        } else if (line.startsWith(":")) {
          // Comment / heartbeat
          continue;
        } else {
          const colonIndex = line.indexOf(":");
          if (colonIndex === -1) {
            if (line === "data") {
              currentDataLines.push("");
            }
          } else {
            const field = line.slice(0, colonIndex);
            let val = line.slice(colonIndex + 1);
            if (val.startsWith(" ")) {
              val = val.slice(1);
            }

            if (field === "event") {
              currentEventName = val;
            } else if (field === "data") {
              currentDataLines.push(val);
            }
          }
        }
      }
    }

    // Process leftover buffer if there's no trailing newline
    if (buffer !== "") {
      accumulatedEventSize += buffer.length;
      if (accumulatedEventSize > MAX_EVENT_SIZE) {
        throw new Error("Stream event size exceeded limit.");
      }

      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line !== "" && !line.startsWith(":")) {
        const colonIndex = line.indexOf(":");
        if (colonIndex !== -1) {
          const field = line.slice(0, colonIndex);
          let val = line.slice(colonIndex + 1);
          if (val.startsWith(" ")) {
            val = val.slice(1);
          }
          if (field === "event") {
            currentEventName = val;
          } else if (field === "data") {
            currentDataLines.push(val);
          }
        }
      }
      if (currentEventName || currentDataLines.length > 0) {
        const dataStr = currentDataLines.join("\n");
        let parsedData: unknown = null;
        if (dataStr) {
          try {
            parsedData = JSON.parse(dataStr);
          } catch {
            throw new Error("Malformed JSON in stream data.");
          }
        }
        if (currentEventName === "ready") {
          callbacks.onReady?.(parsedData);
        } else if (currentEventName === "result") {
          callbacks.onResult?.(parsedData);
          eventDispatched = true;
        } else if (currentEventName === "error") {
          callbacks.onError?.(parsedData);
          eventDispatched = true;
        }
      }
    }

    if (!eventDispatched) {
      throw new Error("Stream connection ended before a result or error event was received.");
    }
  } catch (err) {
    hasError = true;
    try {
      await reader.cancel();
    } catch {}
    throw err;
  } finally {
    if (!hasError) {
      reader.releaseLock();
    }
  }
}
