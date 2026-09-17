/**
 * Port of cover_agent/ai_caller_replay.py
 *
 * The word-by-word "typing" animation from Python is dropped; the recorded text is printed as-is.
 */
import { getLogger, type Logger } from "../logger.js";
import { RecordReplayManager } from "./recordReplayManager.js";
import type { ModelCaller, ModelResponse, Prompt } from "./types.js";

export interface AICallerReplayOptions {
  recordReplayManager?: RecordReplayManager;
  logger?: Logger;
  out?: NodeJS.WritableStream;
}

export class AICallerReplay implements ModelCaller {
  private readonly manager: RecordReplayManager;
  private readonly logger: Logger;
  private readonly out: NodeJS.WritableStream;

  constructor(
    private readonly sourceFile: string,
    private readonly testFile: string,
    options: AICallerReplayOptions = {},
  ) {
    this.manager = options.recordReplayManager ?? new RecordReplayManager(false);
    this.logger = options.logger ?? getLogger("ai_caller_replay");
    this.out = options.out ?? process.stdout;
  }

  async callModel(prompt: Prompt, callerName: string): Promise<ModelResponse> {
    const recorded = this.manager.loadRecordedResponse(this.sourceFile, this.testFile, prompt, callerName);
    if (!recorded) {
      const msg =
        `No recorded response found for prompt hash in replay mode. ` +
        `Source file: ${this.sourceFile}, Test file: ${this.testFile}.`;
      this.logger.error(msg);
      throw new Error(msg);
    }
    this.logger.info("▶️  Replaying results from recorded LLM response...");
    this.out.write(recorded.content + "\n");
    return recorded;
  }
}
