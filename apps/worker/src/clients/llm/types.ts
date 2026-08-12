import type { Env } from "@worker/types";

export interface EmailAnalysis {
  summary: string;
  shortSummary: string;
  tags: string[];
  isJunk: boolean;
  junkConfidence: number;
}

export interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
  error?: string | { message?: string };
  response?: unknown;
}

export interface ResponsesStreamState {
  text: string;
  fallbackText: string | null;
}

export type LLMClientEnv = Pick<
  Env,
  "LLM_API_KEY" | "LLM_API_URL" | "LLM_MODEL"
>;
