/**
 * Port of cover_agent/unit_test_validator.py
 *
 * The insert -> run -> check pass -> check coverage increase -> keep-or-rollback algorithm
 * is ported line-for-line, including the LLM-driven discovery of indentation and insertion
 * lines. Differences:
 * - diff coverage is computed natively (coverage/diffCoverage.ts) instead of shelling out
 *   to Python's diff-cover
 * - a generated test that cannot be inserted returns a FAIL result instead of None
 *   (upstream then crashed while writing the attempt to the DB)
 * - a file that newly appears in the report no longer throws a KeyError when logging
 *   per-file increases under --use-report-coverage-feature-flag
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, relative } from "node:path";
import type { AgentCompletion } from "./agentCompletion/types.js";
import type { CoverageType } from "./config/schema.js";
import { getSettings } from "./config/settings.js";
import {
  CoverageProcessor,
  UnsupportedCoverageReportError,
  type FileCoverage,
} from "./coverage/coverageProcessor.js";
import { computeDiffCoverage, getChangedLines, type GitRunner } from "./coverage/diffCoverage.js";
import { getLogger, type Logger } from "./logger.js";
import { runCommand, type RunCommand } from "./runner.js";
import type { FailedTestRun, GeneratedTest } from "./unitTestGenerator.js";
import { numberLines } from "./unitTestGenerator.js";
import { getCodeLanguage } from "./utils/language.js";
import { asRecord, loadYaml } from "./utils/loadYaml.js";
import { formatPyFloat } from "./utils/pyCompat.js";

export type AttemptStatus = "PASS" | "FAIL";

export interface TestAttemptResult {
  status: AttemptStatus;
  reason: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  test: GeneratedTest;
  language: string;
  sourceFile: string;
  originalTestFile: string;
  processedTestFile: string;
  prompt?: string;
}

export interface UnitTestValidatorOptions {
  sourceFilePath: string;
  testFilePath: string;
  codeCoverageReportPath: string;
  testCommand: string;
  testCommandDir: string;
  coverageType: CoverageType;
  desiredCoverage: number;
  maxRunTimeSec: number;
  agentCompletion: AgentCompletion;
  projectRoot?: string;
  additionalInstructions?: string;
  useReportCoverageFeatureFlag?: boolean;
  diffCoverage?: boolean;
  comparisonBranch?: string;
  numAttempts?: number;
  logger?: Logger;
  runner?: RunCommand;
  git?: GitRunner;
}

export class UnitTestValidator {
  readonly sourceFilePath: string;
  readonly testFilePath: string;
  readonly desiredCoverage: number;
  readonly language: string;

  currentCoverage = 0;
  lastCoveragePercentages: Record<string, number> = {};
  failedTestRuns: FailedTestRun[] = [];
  testingFramework = "Unknown";
  codeCoverageReport = "";
  totalInputTokenCount = 0;
  totalOutputTokenCount = 0;

  testHeadersIndentation: number | null = null;
  relevantLineNumberToInsertTestsAfter: number | null = null;
  relevantLineNumberToInsertImportsAfter: number | null = null;

  private readonly o: Required<
    Pick<
      UnitTestValidatorOptions,
      | "codeCoverageReportPath"
      | "testCommand"
      | "testCommandDir"
      | "maxRunTimeSec"
      | "projectRoot"
      | "additionalInstructions"
      | "useReportCoverageFeatureFlag"
      | "diffCoverage"
      | "comparisonBranch"
      | "numAttempts"
    >
  >;
  private readonly agentCompletion: AgentCompletion;
  private readonly coverageProcessor: CoverageProcessor;
  private readonly logger: Logger;
  private readonly runner: RunCommand;
  private readonly git: GitRunner | undefined;
  private readonly sourceCode: string;

  constructor(options: UnitTestValidatorOptions) {
    this.sourceFilePath = options.sourceFilePath;
    this.testFilePath = options.testFilePath;
    this.desiredCoverage = options.desiredCoverage;
    this.agentCompletion = options.agentCompletion;
    this.logger = options.logger ?? getLogger("unit_test_validator");
    this.runner = options.runner ?? runCommand;
    this.git = options.git;
    this.o = {
      codeCoverageReportPath: options.codeCoverageReportPath,
      testCommand: options.testCommand,
      testCommandDir: options.testCommandDir,
      maxRunTimeSec: options.maxRunTimeSec,
      projectRoot: options.projectRoot ?? "",
      additionalInstructions: options.additionalInstructions ?? "",
      useReportCoverageFeatureFlag: options.useReportCoverageFeatureFlag ?? false,
      diffCoverage: options.diffCoverage ?? false,
      comparisonBranch: options.comparisonBranch ?? "main",
      numAttempts: options.numAttempts ?? 1,
    };
    this.language = getCodeLanguage(this.sourceFilePath);
    this.sourceCode = readFileSync(this.sourceFilePath, "utf8");

    if (this.o.diffCoverage) {
      this.logger.info(`Diff coverage enabled. Comparing against branch "${this.o.comparisonBranch}".`);
    }

    this.coverageProcessor = new CoverageProcessor({
      reportPath: this.o.codeCoverageReportPath,
      srcFilePath: this.sourceFilePath,
      coverageType: options.coverageType,
    });
  }

  private rel(p: string): string {
    return relative(this.o.projectRoot || process.cwd(), p);
  }

  async getCoverage(): Promise<{
    failedTestRuns: FailedTestRun[];
    language: string;
    testingFramework: string;
    codeCoverageReport: string;
  }> {
    await this.runCoverage();
    return {
      failedTestRuns: this.failedTestRuns,
      language: this.language,
      testingFramework: this.testingFramework,
      codeCoverageReport: this.codeCoverageReport,
    };
  }

  async initialTestSuiteAnalysis(): Promise<void> {
    try {
      const allowedAttempts = Number(getSettings().default["test_headers_indentation_attempts"] ?? 3);

      let testHeadersIndentation: unknown = null;
      let lastResponse = "";
      for (let attempt = 0; testHeadersIndentation == null && attempt < allowedAttempts; attempt++) {
        const r = await this.agentCompletion.analyzeSuiteTestHeadersIndentation({
          language: this.language,
          testFileName: this.rel(this.testFilePath),
          testFile: this.readFile(this.testFilePath),
        });
        this.totalInputTokenCount += r.promptTokens;
        this.totalOutputTokenCount += r.completionTokens;
        lastResponse = r.response;
        testHeadersIndentation = asRecord(loadYaml(r.response))?.["test_headers_indentation"] ?? null;
      }
      if (testHeadersIndentation == null) {
        throw new Error(`Failed to analyze the test headers indentation. YAML response: ${lastResponse}`);
      }

      let insertTestsAfter: unknown = null;
      let insertImportsAfter: unknown = null;
      let lastDict: unknown;
      for (let attempt = 0; !insertTestsAfter && attempt < allowedAttempts; attempt++) {
        const r = await this.agentCompletion.analyzeTestInsertLine({
          language: this.language,
          testFileNumbered: numberLines(this.readFile(this.testFilePath)),
          additionalInstructionsText: this.o.additionalInstructions,
          testFileName: this.rel(this.testFilePath),
        });
        this.totalInputTokenCount += r.promptTokens;
        this.totalOutputTokenCount += r.completionTokens;
        const dict = asRecord(loadYaml(r.response));
        lastDict = dict;
        insertTestsAfter = dict?.["relevant_line_number_to_insert_tests_after"] ?? null;
        insertImportsAfter = dict?.["relevant_line_number_to_insert_imports_after"] ?? null;
        this.testingFramework = String(dict?.["testing_framework"] ?? "Unknown").trim();
      }
      if (!insertTestsAfter) {
        throw new Error(
          `Failed to analyze the relevant line number to insert new tests. tests_dict: ${JSON.stringify(lastDict)}`,
        );
      }
      if (!insertImportsAfter) {
        throw new Error(
          `Failed to analyze the relevant line number to insert new imports. tests_dict: ${JSON.stringify(lastDict)}`,
        );
      }

      this.testHeadersIndentation = Number(testHeadersIndentation);
      this.relevantLineNumberToInsertTestsAfter = Number(insertTestsAfter);
      this.relevantLineNumberToInsertImportsAfter = Number(insertImportsAfter);
    } catch (e) {
      this.logger.error(`Error during initial test suite analysis: ${String(e)}`);
      throw new Error("Error during initial test suite analysis", { cause: e });
    }
  }

  async runCoverage(): Promise<void> {
    this.logger.info(`Running build/test command to generate coverage report: "${this.o.testCommand}"`);
    const { stdout, stderr, exitCode, commandStartTime } = await this.runner(
      this.o.testCommand,
      this.o.maxRunTimeSec,
      this.o.testCommandDir,
    );
    if (exitCode !== 0) {
      throw new Error(
        `Fatal: Error running test command. Are you sure the command is correct? "${this.o.testCommand}"\n` +
          `Exit code ${exitCode}. \nStdout: \n${stdout} \nStderr: \n${stderr}`,
      );
    }

    try {
      const { percentageCovered, coveragePercentages } =
        await this.postProcessCoverageReport(commandStartTime);
      this.currentCoverage = percentageCovered;
      this.lastCoveragePercentages = { ...coveragePercentages };
      this.logger.info(`Initial coverage: ${formatPyFloat(this.currentCoverage * 100)}%`);
    } catch (e) {
      if (e instanceof UnsupportedCoverageReportError) {
        this.logger.warn(`Error parsing coverage report: ${e.message}`);
        this.logger.info(
          "Will default to using the full coverage report. You will need to check coverage manually for each passing test.",
        );
        this.codeCoverageReport = readFileSync(this.o.codeCoverageReportPath, "utf8");
        return;
      }
      this.logger.error(`Error in coverage processing: ${String(e)}`);
      throw e;
    }
  }

  async validateTest(generatedTest: GeneratedTest): Promise<TestAttemptResult> {
    const originalContent = readFileSync(this.testFilePath, "utf8");
    const base = {
      test: generatedTest,
      language: this.language,
      sourceFile: this.sourceCode,
      originalTestFile: originalContent,
    };
    const rollback = () => writeFileSync(this.testFilePath, originalContent);

    try {
      // Step 0: each generated test is assumed to be self-contained
      const testCode = String(generatedTest.test_code ?? "").trimEnd();
      let additionalImports = String(generatedTest.new_imports_code ?? "").trim();
      if (additionalImports.startsWith('"') && additionalImports.endsWith('"')) {
        additionalImports = additionalImports.replace(/^"+|"+$/g, "");
      }
      if (additionalImports === '""') additionalImports = "";

      const insertTestsAfter = this.relevantLineNumberToInsertTestsAfter;
      const insertImportsAfter = this.relevantLineNumberToInsertImportsAfter;

      // Re-indent the test to the suite's header indentation
      let testCodeIndented = testCode;
      const neededIndent = this.testHeadersIndentation;
      if (neededIndent) {
        const initialIndent = testCode.length - testCode.trimStart().length;
        const delta = neededIndent - initialIndent;
        if (delta > 0) {
          testCodeIndented = testCode
            .split("\n")
            .map((line) => " ".repeat(delta) + line)
            .join("\n");
        }
      }
      testCodeIndented = "\n" + testCodeIndented.replace(/^\n+|\n+$/g, "") + "\n";

      if (!(testCodeIndented && insertTestsAfter)) {
        return {
          ...base,
          status: "FAIL",
          reason: "No insertion point available for the generated test",
          exitCode: null,
          stderr: "",
          stdout: "",
          processedTestFile: "N/A",
        };
      }

      // Step 1: insert imports first, then the generated test
      let lines = originalContent.split("\n");
      const additionalImportLines: string[] = [];
      if (additionalImports) {
        for (const line of additionalImports.split("\n")) {
          if (line.trim() && lines.every((existing) => line.trim() !== existing.trim())) {
            additionalImportLines.push(line);
          }
        }
      }

      let insertedLinesCount = 0;
      if (insertImportsAfter && additionalImportLines.length) {
        insertedLinesCount = additionalImportLines.length;
        lines = [...lines.slice(0, insertImportsAfter), ...additionalImportLines, ...lines.slice(insertImportsAfter)];
      }

      const testInsertionPoint = insertTestsAfter + insertedLinesCount;
      const processedTest = [
        ...lines.slice(0, testInsertionPoint),
        ...testCodeIndented.split("\n"),
        ...lines.slice(testInsertionPoint),
      ].join("\n");
      writeFileSync(this.testFilePath, processedTest);

      // Step 2: run the tests
      let run = { stdout: "", stderr: "", exitCode: 0, commandStartTime: Date.now() };
      for (let i = 0; i < this.o.numAttempts; i++) {
        this.logger.info(`Running test with the following command: "${this.o.testCommand}"`);
        run = await this.runner(this.o.testCommand, this.o.maxRunTimeSec, this.o.testCommandDir);
        if (run.exitCode !== 0) break;
      }
      const runDetails = {
        ...base,
        exitCode: run.exitCode,
        stderr: run.stderr,
        stdout: run.stdout,
        processedTestFile: processedTest,
      };

      // Step 3: pass/fail
      if (run.exitCode !== 0) {
        rollback();
        this.logger.info("Skipping a generated test that failed");
        const failDetails: TestAttemptResult = { ...runDetails, status: "FAIL", reason: "Test failed" };
        const errorMessage = await this.extractErrorMessage(failDetails);
        if (errorMessage) this.logger.error(`Error message summary:\n${errorMessage}`);
        this.failedTestRuns.push({ code: generatedTest, errorMessage });
        return failDetails;
      }

      // Step 4: coverage must increase
      let newPercentage: number;
      let newPercentages: Record<string, number>;
      try {
        ({ percentageCovered: newPercentage, coveragePercentages: newPercentages } =
          await this.postProcessCoverageReport(run.commandStartTime));
        if (newPercentage <= this.currentCoverage) {
          rollback();
          this.logger.info("Test did not increase coverage. Rolling back.");
          this.failedTestRuns.push({ code: generatedTest, errorMessage: "Test did not increase code coverage" });
          return {
            ...runDetails,
            status: "FAIL",
            reason:
              "Coverage did not increase. Maybe the test did run but did not increase coverage, or maybe the test execution was skipped due to some problem",
          };
        }
      } catch (e) {
        this.logger.error(`Error during coverage verification: ${String(e)}`);
        rollback();
        this.failedTestRuns.push({ code: generatedTest, errorMessage: "Coverage verification error" });
        return { ...runDetails, status: "FAIL", reason: "Runtime error" };
      }

      // Success: keep the test. Shift the test insertion point by the import lines we added,
      // otherwise the next test lands on the wrong line.
      this.relevantLineNumberToInsertTestsAfter = insertTestsAfter + additionalImportLines.length;

      const srcBase = basename(this.sourceFilePath);
      for (const [key, value] of Object.entries(newPercentages)) {
        const previous = this.lastCoveragePercentages[key] ?? 0;
        if (value > previous) {
          const kind = key.split("/").pop() === srcBase ? "provided source file" : "non-source file";
          this.logger.info(
            `Coverage for ${kind}: ${key} increased from ${formatPyFloat(previous * 100)} to ${formatPyFloat(value * 100)}`,
          );
        }
      }
      this.currentCoverage = newPercentage;
      this.lastCoveragePercentages = { ...newPercentages };
      this.logger.info(
        `Test passed and coverage increased. Current coverage: ${formatPyFloat(newPercentage * 100)}%`,
      );
      return { ...runDetails, status: "PASS", reason: "" };
    } catch (e) {
      this.logger.error(`Error validating test: ${String(e)}`);
      return {
        ...base,
        status: "FAIL",
        reason: `Error validating test: ${String(e)}`,
        exitCode: null,
        stderr: String(e),
        stdout: "",
        processedTestFile: "N/A",
      };
    }
  }

  async extractErrorMessage(failDetails: TestAttemptResult): Promise<string> {
    try {
      const r = await this.agentCompletion.analyzeTestFailure({
        sourceFileName: this.rel(this.sourceFilePath),
        sourceFile: this.readFile(this.sourceFilePath),
        processedTestFile: failDetails.processedTestFile,
        stderr: failDetails.stderr,
        stdout: failDetails.stdout,
        testFileName: this.rel(this.testFilePath),
      });
      this.totalInputTokenCount += r.promptTokens;
      this.totalOutputTokenCount += r.completionTokens;
      return r.response.trim();
    } catch (e) {
      this.logger.error(`Error extracting error message: ${String(e)}`);
      return "";
    }
  }

  async postProcessCoverageReport(
    timeOfTestCommand: number,
  ): Promise<{ percentageCovered: number; coveragePercentages: Record<string, number> }> {
    const coveragePercentages: Record<string, number> = {};

    if (this.o.useReportCoverageFeatureFlag) {
      this.logger.info("Using the report coverage feature flag to process the coverage report");
      const all = this.coverageProcessor.processCoverageReportAllFiles(timeOfTestCommand);
      let covered = 0;
      let missed = 0;
      for (const [file, cov] of all) {
        covered += cov.linesCovered.length;
        missed += cov.linesMissed.length;
        coveragePercentages[file] = cov.percentageCovered;
      }
      const total = covered + missed;
      if (total === 0) {
        this.logger.error(
          `ZeroDivisionError: Attempting to perform total_lines_covered / total_lines: ${covered} / ${total}.`,
        );
      }
      const percentageCovered = total ? covered / total : 0;
      this.logger.info(`Total lines covered: ${covered}, Total lines missed: ${missed}, Total lines: ${total}`);
      this.logger.info(`coverage: Percentage ${formatPyFloat(percentageCovered * 100)}%`);
      return { percentageCovered, coveragePercentages };
    }

    let cov: FileCoverage;
    if (this.o.diffCoverage) {
      this.coverageProcessor.verifyReportUpdate(timeOfTestCommand);
      const sourceCoverage = this.coverageProcessor.parseCoverageReport();
      const changed = await getChangedLines(this.o.comparisonBranch, this.o.testCommandDir, this.git);
      cov = computeDiffCoverage(sourceCoverage, changed, this.sourceFilePath, this.logger);
    } else {
      cov = this.coverageProcessor.processCoverageReport(timeOfTestCommand);
    }
    this.codeCoverageReport =
      `Lines covered: ${pyList(cov.linesCovered)}\nLines missed: ${pyList(cov.linesMissed)}\n` +
      `Percentage covered: ${formatPyFloat(cov.percentageCovered * 100)}%`;
    return { percentageCovered: cov.percentageCovered, coveragePercentages };
  }

  private readFile(filePath: string): string {
    try {
      return readFileSync(filePath, "utf8");
    } catch (e) {
      return `Error reading ${filePath}: ${String(e)}`;
    }
  }
}

/** Python's str(list[int]): "[1, 2, 3]" */
function pyList(values: number[]): string {
  return `[${values.join(", ")}]`;
}
