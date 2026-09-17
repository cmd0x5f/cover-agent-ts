/** Programmatic API, for embedding the loop in CI helpers or other tools. */
export { CoverAgent, type CoverAgentDeps, type RunResult } from "./coverAgent.js";
export { buildConfig, type CoverAgentConfig, type CoverageType } from "./config/schema.js";
export { configureLogging, getLogger, type Logger } from "./logger.js";
export { AICaller } from "./ai/aiCaller.js";
export { AICallerReplay } from "./ai/aiCallerReplay.js";
export { RecordReplayManager } from "./ai/recordReplayManager.js";
export { resolveModel, parseModelString, type ModelResolver } from "./ai/modelRegistry.js";
export type { ModelCaller, ModelResponse, Prompt } from "./ai/types.js";
export { DefaultAgentCompletion, buildPrompt } from "./agentCompletion/defaultAgentCompletion.js";
export type * from "./agentCompletion/types.js";
export { CoverageProcessor, type FileCoverage } from "./coverage/coverageProcessor.js";
export { UnitTestGenerator } from "./unitTestGenerator.js";
export { UnitTestValidator, type TestAttemptResult } from "./unitTestValidator.js";
export { UnitTestDB } from "./unitTestDb.js";
export { runCommand, type RunCommand } from "./runner.js";
