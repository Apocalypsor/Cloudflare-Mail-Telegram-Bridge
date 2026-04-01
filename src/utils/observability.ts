import { TelegramErrorReporter } from "workers-observability-hub";
import type { Env } from "@/types";

type ErrorContext = Record<string, unknown>;

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
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    context,
    timestamp: new Date().toISOString(),
  });
}
