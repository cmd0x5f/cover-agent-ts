/**
 * Port of cover_agent/ai_caller.py
 *
 * LiteLLM is replaced by the Vercel AI SDK (see modelRegistry.ts). Behavioural parity:
 * - temperature 0.2, max tokens 8192 (as passed by CoverAgent), streaming by default
 * - o1-preview / o1-mini: system prompt folded into the user message
 * - o-series reasoning models: no streaming, temperature 1, 2x output token budget
 * - retries: `model_retries` attempts with a fixed 1s wait (tenacity equivalent)
 * - optional recording of every response for later replay
 *
 * Weights & Biases tracing is not ported.
 */
import { generateText, streamText } from "ai";
import { getSettings } from "../config/settings.js";
import { getLogger, type Logger } from "../logger.js";
import { resolveModel, type ModelResolver } from "./modelRegistry.js";
import { RecordReplayManager } from "./recordReplayManager.js";
import type { ModelCaller, ModelResponse, Prompt } from "./types.js";

const SYSTEM_IN_USER_MODELS = new Set(["o1-preview", "o1-mini"]);
const REASONING_MODELS = new Set(["o1-preview", "o1-mini", "o1", "o3-mini"]);

export interface AICallerOptions {
  model: string;
  apiBase?: string;
  enableRetry?: boolean;
  maxTokens?: number;
  temperature?: number;
  sourceFile?: string;
  testFile?: string;
  recordMode?: boolean;
  recordReplayManager?: RecordReplayManager;
  logger?: Logger;
  resolver?: ModelResolver;
  out?: NodeJS.WritableStream;
  retryDelayMs?: number;
}

export class AICaller implements ModelCaller {
  readonly model: string;
  private readonly apiBase: string;
  private readonly enableRetry: boolean;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly sourceFile: string | undefined;
  private readonly testFile: string | undefined;
  private readonly recordMode: boolean;
  private readonly recordReplayManager: RecordReplayManager;
  private readonly logger: Logger;
  private readonly resolver: ModelResolver;
  private readonly out: NodeJS.WritableStream;
  private readonly retryDelayMs: number;

  constructor(options: AICallerOptions) {
    this.model = options.model;
    this.apiBase = options.apiBase ?? "";
    this.enableRetry = options.enableRetry ?? true;
    this.maxTokens = options.maxTokens ?? 16384;
    this.temperature = options.temperature ?? 0.2;
    this.sourceFile = options.sourceFile;
    this.testFile = options.testFile;
    this.recordMode = options.recordMode ?? false;
    this.recordReplayManager = options.recordReplayManager ?? new RecordReplayManager(this.recordMode);
    this.logger = options.logger ?? getLogger("ai_caller");
    this.resolver = options.resolver ?? resolveModel;
    this.out = options.out ?? process.stdout;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  async callModel(prompt: Prompt, callerName: string, options: { stream?: boolean } = {}): Promise<ModelResponse> {
    if (typeof prompt.system !== "string" || typeof prompt.user !== "string") {
      throw new Error("The prompt must contain 'system' and 'user' keys.");
    }
    const attempts = this.enableRetry ? Math.max(1, getSettings().default.model_retries ?? 3) : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.callOnce(prompt, callerName, options.stream ?? true);
      } catch (e) {
        lastError = e;
        if (attempt < attempts) {
          this.logger.warn(`LLM call failed (attempt ${attempt}/${attempts}): ${String(e)}. Retrying...`);
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
      }
    }
    throw lastError;
  }

  private async callOnce(prompt: Prompt, callerName: string, streamRequested: boolean): Promise<ModelResponse> {
    const bareModel = this.model.includes("/") ? this.model.slice(this.model.lastIndexOf("/") + 1) : this.model;

    let system: string | undefined = prompt.system === "" ? undefined : prompt.system;
    let user = prompt.user;
    if (system !== undefined && SYSTEM_IN_USER_MODELS.has(bareModel)) {
      user = `${system}\n${user}`;
      system = undefined;
    }

    let stream = streamRequested;
    let temperature: number | undefined = this.temperature;
    let maxOutputTokens = this.maxTokens;
    if (REASONING_MODELS.has(bareModel)) {
      stream = false;
      temperature = 1;
      maxOutputTokens = 2 * this.maxTokens;
    }

    const { model } = await this.resolver(this.model, this.apiBase);
    const common = {
      model,
      ...(system !== undefined ? { instructions: system } : {}),
      prompt: user,
      temperature,
      maxOutputTokens,
      maxRetries: 0, // retries are handled in callModel to mirror upstream semantics
    };

    this.logger.info(`📣 Calling LLM from ${callerName}()...`);
    let content: string;
    let promptTokens: number;
    let completionTokens: number;

    try {
      if (stream) {
        this.logger.info("Streaming results from LLM model...");
        const result = streamText(common);
        const chunks: string[] = [];
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            chunks.push(part.text);
            this.out.write(part.text);
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }
        this.out.write("\n\n");
        content = chunks.join("");
        const usage = await result.usage;
        promptTokens = usage.inputTokens ?? 0;
        completionTokens = usage.outputTokens ?? 0;
      } else {
        const result = await generateText(common);
        content = result.text;
        this.logger.info("Printing results from LLM model...");
        this.out.write(content + "\n");
        promptTokens = result.usage.inputTokens ?? 0;
        completionTokens = result.usage.outputTokens ?? 0;
      }
    } catch (e) {
      this.logger.error(`Error calling LLM model: ${String(e)}`);
      throw e;
    }

    const response: ModelResponse = { content, promptTokens, completionTokens };
    if (this.recordMode && this.sourceFile && this.testFile) {
      this.recordReplayManager.recordResponse(this.sourceFile, this.testFile, prompt, response, callerName);
    }
    return response;
  }
}
