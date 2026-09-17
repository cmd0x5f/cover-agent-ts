/**
 * Port of cover_agent/cover_agent.py
 *
 * The Python constructor did async work (an LLM call to adapt the test command), so here
 * construction is split into `CoverAgent.create()`. `run()` returns an exit code instead of
 * calling sys.exit(), so the loop can be embedded (e.g. in a GitLab CI helper) and tested.
 */
import { copyFileSync, existsSync, statSync } from "node:fs";
import { relative } from "node:path";
import { AICaller } from "./ai/aiCaller.js";
import { AICallerReplay } from "./ai/aiCallerReplay.js";
import type { ModelResolver } from "./ai/modelRegistry.js";
import { RecordReplayManager } from "./ai/recordReplayManager.js";
import type { ModelCaller } from "./ai/types.js";
import { DefaultAgentCompletion } from "./agentCompletion/defaultAgentCompletion.js";
import type { AgentCompletion } from "./agentCompletion/types.js";
import type { CoverAgentConfig } from "./config/schema.js";
import type { GitRunner } from "./coverage/diffCoverage.js";
import { getLogger, type Logger } from "./logger.js";
import type { RunCommand } from "./runner.js";
import { UnitTestDB } from "./unitTestDb.js";
import { UnitTestGenerator, type FailedTestRun } from "./unitTestGenerator.js";
import { UnitTestValidator } from "./unitTestValidator.js";
import { getIncludedFiles } from "./utils/includedFiles.js";
import { formatPyFloat } from "./utils/pyCompat.js";

export interface CoverAgentDeps {
  agentCompletion?: AgentCompletion;
  logger?: Logger;
  runner?: RunCommand;
  git?: GitRunner;
  modelResolver?: ModelResolver;
}

export interface RunResult {
  exitCode: number;
  iterations: number;
  /** 0..1 */
  finalCoverage: number;
  targetReached: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface CoverageState {
  failedTestRuns: FailedTestRun[];
  language: string;
  testingFramework: string;
  codeCoverageReport: string;
}

export class CoverAgent {
  readonly config: CoverAgentConfig;
  readonly testGen: UnitTestGenerator;
  readonly testValidator: UnitTestValidator;
  private readonly logger: Logger;
  private readonly testDb: UnitTestDB | undefined;

  private constructor(
    config: CoverAgentConfig,
    parts: { testGen: UnitTestGenerator; testValidator: UnitTestValidator; logger: Logger; testDb?: UnitTestDB },
  ) {
    this.config = config;
    this.testGen = parts.testGen;
    this.testValidator = parts.testValidator;
    this.logger = parts.logger;
    this.testDb = parts.testDb;
  }

  static async create(inputConfig: CoverAgentConfig, deps: CoverAgentDeps = {}): Promise<CoverAgent> {
    const config: CoverAgentConfig = { ...inputConfig };
    const logger = deps.logger ?? getLogger("cover_agent");
    const generateLogFiles = !config.suppressLogFiles;
    if (config.suppressLogFiles) logger.info("Suppressed all generated log files.");

    CoverAgent.validatePaths(config);
    const testDb = generateLogFiles ? new UnitTestDB(config.logDbPath) : undefined;

    // _duplicate_test_file
    if (config.testFileOutputPath !== "") {
      copyFileSync(config.testFilePath, config.testFileOutputPath);
    } else {
      config.testFileOutputPath = config.testFilePath;
    }

    const agentCompletion =
      deps.agentCompletion ??
      new DefaultAgentCompletion(CoverAgent.initializeAiCaller(config, logger, deps.modelResolver));

    if (config.runEachTestSeparately) {
      const testFileRelativePath = relative(config.projectRoot || process.cwd(), config.testFileOutputPath);
      const original = config.testCommand;
      let newCommandLine: string | null = null;
      if (original.includes("pytest")) {
        const ind1 = original.indexOf("pytest");
        const ind2 = original.slice(ind1).indexOf("--");
        if (ind2 === -1) logger.error(`Failed to adapt test command for running a single test: ${original}`);
        else newCommandLine = `${original.slice(0, ind1)}pytest ${testFileRelativePath} ${original.slice(ind1 + ind2)}`;
      } else {
        const r = await agentCompletion.adaptTestCommandForASingleTestViaAi({
          testFileRelativePath,
          testCommand: original,
          projectRootDir: config.testCommandDir,
        });
        newCommandLine = r.response;
      }
      if (newCommandLine) {
        config.testCommandOriginal = original;
        config.testCommand = newCommandLine;
        logger.info(`Converting test command: \`${original}\`\n to run only a single test: \`${newCommandLine}\``);
      }
    }

    const testGen = new UnitTestGenerator({
      sourceFilePath: config.sourceFilePath,
      testFilePath: config.testFileOutputPath,
      projectRoot: config.projectRoot,
      agentCompletion,
      includedFilesContent: getIncludedFiles(config.includedFiles, config.projectRoot),
      additionalInstructions: config.additionalInstructions,
    });

    const testValidator = new UnitTestValidator({
      sourceFilePath: config.sourceFilePath,
      testFilePath: config.testFileOutputPath,
      projectRoot: config.projectRoot,
      codeCoverageReportPath: config.codeCoverageReportPath,
      testCommand: config.testCommand,
      testCommandDir: config.testCommandDir,
      coverageType: config.coverageType,
      desiredCoverage: config.desiredCoverage,
      additionalInstructions: config.additionalInstructions,
      useReportCoverageFeatureFlag: config.useReportCoverageFeatureFlag,
      diffCoverage: config.diffCoverage,
      comparisonBranch: config.branch,
      numAttempts: config.runTestsMultipleTimes,
      agentCompletion,
      maxRunTimeSec: config.maxRunTimeSec,
      ...(deps.runner ? { runner: deps.runner } : {}),
      ...(deps.git ? { git: deps.git } : {}),
    });

    return new CoverAgent(config, { testGen, testValidator, logger, ...(testDb ? { testDb } : {}) });
  }

  private static initializeAiCaller(
    config: CoverAgentConfig,
    logger: Logger,
    resolver: ModelResolver | undefined,
  ): ModelCaller {
    const params = {
      model: config.model,
      apiBase: config.apiBase,
      maxTokens: 8192,
      sourceFile: config.sourceFilePath,
      testFile: config.testFilePath,
      ...(resolver ? { resolver } : {}),
    };
    if (config.recordMode) {
      logger.info("Initializing AICaller in Record mode...");
      return new AICaller({ ...params, recordMode: true, recordReplayManager: new RecordReplayManager(true) });
    }
    try {
      const replayManager = new RecordReplayManager(false);
      if (replayManager.hasResponseFile(config.sourceFilePath, config.testFilePath)) {
        logger.info("Initializing AICallerReplay (found recorded responses)...");
        return new AICallerReplay(config.sourceFilePath, config.testFilePath, {
          recordReplayManager: replayManager,
        });
      }
    } catch (e) {
      logger.debug(`Failed to initialize replay mode: ${String(e)}`);
    }
    logger.info("Initializing AICaller without recording (no recorded responses found)");
    return new AICaller({ ...params, recordMode: false });
  }

  private static validatePaths(config: CoverAgentConfig): void {
    if (!isFile(config.sourceFilePath)) throw new Error(`Source file not found at ${config.sourceFilePath}`);
    if (!isFile(config.testFilePath)) throw new Error(`Test file not found at ${config.testFilePath}`);
    if (config.projectRoot && !isDir(config.projectRoot)) {
      throw new Error(`Project root not found at ${config.projectRoot}`);
    }
  }

  async init(): Promise<CoverageState> {
    await this.testValidator.initialTestSuiteAnalysis();
    return this.testValidator.getCoverage();
  }

  logCoverage(): void {
    const label = this.config.diffCoverage ? "Current Diff Coverage" : "Current Coverage";
    this.logger.info(`${label}: ${formatPyFloat(this.testValidator.currentCoverage * 100)}%`);
    this.logger.info(`Desired Coverage: ${this.testValidator.desiredCoverage}%`);
  }

  async generateAndValidateTests(state: CoverageState): Promise<void> {
    this.logCoverage();
    const generated = await this.testGen.generateTests(
      state.failedTestRuns,
      state.language,
      state.testingFramework,
      state.codeCoverageReport,
    );
    for (const test of generated.new_tests) {
      // Sequential on purpose: each test is inserted into, and rolled back from, the same file.
      const result = await this.testValidator.validateTest(test);
      if (this.testDb) this.testDb.insertAttempt({ ...result, prompt: this.testGen.prompt });
    }
  }

  get targetReached(): boolean {
    return this.testValidator.currentCoverage >= this.testValidator.desiredCoverage / 100;
  }

  async run(): Promise<RunResult> {
    let iterationCount = 0;
    let state = await this.init();

    while (iterationCount < this.config.maxIterations) {
      this.logger.info(`Iteration ${iterationCount + 1} of ${this.config.maxIterations}.`);
      await this.generateAndValidateTests(state);
      state = await this.testValidator.getCoverage();
      if (this.targetReached) break;
      iterationCount++;
    }
    return this.finalize(iterationCount);
  }

  finalize(iterationCount: number): RunResult {
    const current = formatPyFloat(this.testValidator.currentCoverage * 100);
    const desired = this.testValidator.desiredCoverage;
    let exitCode = 0;

    if (this.targetReached) {
      this.logger.info(
        `Reached above target coverage of ${desired}% (Current Coverage: ${current}%) in ${iterationCount} iterations.`,
      );
    } else if (iterationCount === this.config.maxIterations) {
      const kind = this.config.diffCoverage ? "diff coverage" : "coverage";
      const msg = `Reached maximum iteration limit without achieving desired ${kind}. Current Coverage: ${current}%`;
      if (this.config.strictCoverage) {
        this.logger.error(msg);
        exitCode = 2;
      } else {
        this.logger.info(msg);
      }
    }

    const totalInputTokens = this.testGen.totalInputTokenCount + this.testValidator.totalInputTokenCount;
    const totalOutputTokens = this.testGen.totalOutputTokenCount + this.testValidator.totalOutputTokenCount;
    this.logger.info(`Total number of input tokens used for LLM model ${this.config.model}: ${totalInputTokens}`);
    this.logger.info(`Total number of output tokens used for LLM model ${this.config.model}: ${totalOutputTokens}`);

    if (this.testDb) {
      this.testDb.dumpToReport(this.config.reportFilepath);
      this.testDb.close();
    }

    return {
      exitCode,
      iterations: iterationCount,
      finalCoverage: this.testValidator.currentCoverage,
      targetReached: this.targetReached,
      totalInputTokens,
      totalOutputTokens,
    };
  }
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}
function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}
