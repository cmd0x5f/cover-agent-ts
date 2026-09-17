import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AICaller } from "../src/ai/aiCaller.js";
import type { ModelResolver } from "../src/ai/modelRegistry.js";
import { parseModelString } from "../src/ai/modelRegistry.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const devNull = { write: () => true } as unknown as NodeJS.WritableStream;
const usage = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};
const finish = { unified: "stop" as const, raw: "stop" };

function streamingModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "1" },
          ...text.split(" ").map((w, i) => ({ type: "text-delta" as const, id: "1", delta: (i ? " " : "") + w })),
          { type: "text-end" as const, id: "1" },
          { type: "finish" as const, usage, finishReason: finish },
        ],
      }),
    }),
  });
}

const resolverFor = (model: MockLanguageModelV4): ModelResolver => async (m) => ({ model, provider: "mock", modelId: m });

describe("AICaller", () => {
  it("streams text, returns token usage and passes system as instructions", async () => {
    const model = streamingModel("hello from the model");
    const caller = new AICaller({ model: "anthropic/claude-x", resolver: resolverFor(model), logger: silent, out: devNull });
    const r = await caller.callModel({ system: "be terse", user: "hi" }, "generate_tests");
    expect(r).toEqual({ content: "hello from the model", promptTokens: 11, completionTokens: 7 });
    const call = model.doStreamCalls[0]!;
    expect(call.temperature).toBe(0.2);
    expect(JSON.stringify(call.prompt)).toContain("be terse");
  });

  it("uses non-streaming generation, temperature 1 and 2x tokens for reasoning models", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: "done" }], finishReason: finish, usage, warnings: [] }),
    });
    const caller = new AICaller({ model: "o1-mini", maxTokens: 100, resolver: resolverFor(model), logger: silent, out: devNull });
    const r = await caller.callModel({ system: "sys", user: "user" }, "generate_tests");
    expect(r.content).toBe("done");
    const call = model.doGenerateCalls[0]!;
    expect(call.temperature).toBe(1);
    expect(call.maxOutputTokens).toBe(200);
    // o1-mini: no system message, system folded into user
    expect(call.prompt.some((m) => m.role === "system")).toBe(false);
    expect(JSON.stringify(call.prompt)).toContain("sys\\nuser");
  });

  it("retries failed calls up to model_retries", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        attempts++;
        if (attempts < 3) throw new Error("throttled");
        return { content: [{ type: "text", text: "ok" }], finishReason: finish, usage, warnings: [] };
      },
    });
    const caller = new AICaller({ model: "o3-mini", resolver: resolverFor(model), logger: silent, out: devNull, retryDelayMs: 1 });
    await expect(caller.callModel({ system: "", user: "x" }, "generate_tests")).resolves.toMatchObject({ content: "ok" });
    expect(attempts).toBe(3);
  });
});

describe("parseModelString", () => {
  it("keeps LiteLLM-style model names working", () => {
    expect(parseModelString("bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual({
      provider: "bedrock", modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
    expect(parseModelString("bedrock/converse/eu.anthropic.claude-haiku-4-5")).toEqual({
      provider: "bedrock", modelId: "eu.anthropic.claude-haiku-4-5",
    });
    expect(parseModelString("ollama/qwen2.5-coder:14b")).toEqual({ provider: "ollama", modelId: "qwen2.5-coder:14b" });
    expect(parseModelString("gpt-4o-2024-11-20").provider).toBe("openai");
    expect(parseModelString("claude-sonnet-4-5").provider).toBe("anthropic");
    expect(() => parseModelString("mystery-model")).toThrow(/Cannot infer provider/);
  });
});
