import { analyzeEmail } from "@worker/clients/llm";
import type { Env } from "@worker/types";
import { describe, expect, it } from "vitest";

interface WorkersAiInvocation {
  model: string;
  input: Record<string, unknown>;
}

describe("Workers AI email analysis", () => {
  it("uses the Responses API request format for GPT-5.6 Luna", async () => {
    let invocation: WorkersAiInvocation | undefined;
    const ai = {
      run: async (model: string, input: Record<string, unknown>) => {
        invocation = { model, input };
        return {
          output_text: JSON.stringify({
            summary: "• Order shipped",
            short_summary: "Example order shipped",
            tags: ["Example", "Shipping"],
            junk: { is_junk: false, confidence: 0.02 },
          }),
        };
      },
    } as Ai;

    const result = await analyzeEmail(
      { AI: ai } as Env,
      "Order update",
      "Your order has shipped.",
    );

    expect(invocation).toEqual({
      model: "openai/gpt-5.6-luna",
      input: {
        input: expect.stringContaining(
          "Subject: Order update\n\nBody:\nYour order has shipped.",
        ),
        text: { format: { type: "json_object" } },
      },
    });
    expect(result).toEqual({
      summary: "• Order shipped",
      shortSummary: "Example order shipped",
      tags: ["Example", "Shipping"],
      isJunk: false,
      junkConfidence: 0.02,
    });
  });

  it("reads generated text from a Responses API output message", async () => {
    const ai = {
      run: async () => ({
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_test",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                annotations: [],
                text: JSON.stringify({
                  summary: "• Payment received",
                  short_summary: "Example payment received",
                  tags: ["Example", "Payment"],
                  junk: { is_junk: false, confidence: 0.01 },
                }),
              },
            ],
          },
        ],
      }),
    } as Ai;

    await expect(
      analyzeEmail(
        { AI: ai } as Env,
        "Payment update",
        "Your payment was received.",
      ),
    ).resolves.toEqual({
      summary: "• Payment received",
      shortSummary: "Example payment received",
      tags: ["Example", "Payment"],
      isJunk: false,
      junkConfidence: 0.01,
    });
  });
});
