import type { Env } from "@worker/types";
import { TelegramErrorReporter } from "workers-observability-hub";

type ErrorContext = Record<string, unknown>;

/**
 * Eden treaty 在 `throwHttpError: true` 时抛 `EdenFetchError`（`extends Error`，
 * 带 `.status` / `.value`），但 `.message` 默认就是 `String(value)` —— body 是
 * 对象时变 `"[object Object]"`。这里把它压成可读字符串。
 */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (
      "status" in error &&
      "value" in error &&
      typeof (error as { status: unknown }).status === "number"
    ) {
      const { status, value } = error as Error & {
        status: number;
        value: unknown;
      };
      const detail =
        typeof value === "string"
          ? value
          : value && typeof value === "object" && "error" in value
            ? String((value as { error: unknown }).error)
            : JSON.stringify(value);
      return `HTTP ${status}: ${detail}`;
    }
    return error.message;
  }
  return String(error);
}

export async function reportErrorToObservability(
  env: Env,
  event: string,
  error: unknown,
  context: ErrorContext = {},
): Promise<void> {
  const reporter = new TelegramErrorReporter({
    binding: env.OBS_SERVICE,
    console: true,
  });

  await reporter.reportError({
    source: env.WORKER_NAME || "unknown-worker",
    event,
    message: formatErrorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
    context,
    timestamp: new Date().toISOString(),
  });
}
