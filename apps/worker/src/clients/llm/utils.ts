import type {
  ResponsesStreamEvent,
  ResponsesStreamState,
} from "@worker/clients/llm/types";

export const readResponsesStream = async (
  body: ReadableStream<Uint8Array>,
): Promise<string> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: ResponsesStreamState = { text: "", fallbackText: null };
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = processSseBuffer(buffer, state);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processSseBlock(buffer, state);

  return state.text || state.fallbackText || "";
};

const processSseBuffer = (
  buffer: string,
  state: ResponsesStreamState,
): string => {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  for (const part of parts) processSseBlock(part, state);
  return remainder;
};

const processSseBlock = (block: string, state: ResponsesStreamState): void => {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return;

  let event: ResponsesStreamEvent;
  try {
    event = JSON.parse(data) as ResponsesStreamEvent;
  } catch {
    throw new Error(`LLM stream returned invalid event: ${data.slice(0, 200)}`);
  }

  if (event.type === "response.output_text.delta" && event.delta) {
    state.text += event.delta;
    return;
  }

  if (event.type === "response.output_text.done" && event.text) {
    state.fallbackText = event.text;
    return;
  }

  if (event.type === "response.completed") {
    state.fallbackText =
      extractResponseText(event.response) ?? state.fallbackText;
    return;
  }

  if (
    event.type === "error" ||
    event.type === "response.failed" ||
    event.type === "response.incomplete"
  ) {
    throw new Error(streamErrorMessage(event));
  }
};

const streamErrorMessage = (event: ResponsesStreamEvent): string => {
  if (typeof event.error === "string") return event.error;
  if (event.error?.message) return event.error.message;

  const response = event.response;
  if (response && typeof response === "object") {
    const error = (response as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
    const incomplete = (
      response as { incomplete_details?: { reason?: unknown } }
    ).incomplete_details;
    if (typeof incomplete?.reason === "string") {
      return `LLM response incomplete: ${incomplete.reason}`;
    }
  }

  return `LLM stream error: ${event.type ?? "unknown"}`;
};

const extractResponseText = (response: unknown): string | null => {
  if (!response || typeof response !== "object") return null;
  const outputText = (response as { output_text?: unknown }).output_text;
  if (typeof outputText === "string") return outputText;

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      if (type === "output_text" && typeof text === "string") {
        parts.push(text);
      }
    }
  }

  return parts.length > 0 ? parts.join("") : null;
};
