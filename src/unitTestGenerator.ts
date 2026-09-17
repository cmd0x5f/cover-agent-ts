/**
 * Port of cover_agent/unit_test_generator.py
 *
 * Intentional differences:
 * - The test file is re-read on every generateTests() call. Upstream read it once in
 *   __init__, so from iteration 2 onward the LLM never saw the tests it had already added
 *   and kept proposing duplicates (which then failed the coverage-increase gate).
 * - `additionalIncludesSection` receives the *contents* of --included-files. Upstream passed
 *   the raw CLI list (argparse `type=list` split each path into characters), and with no
 *   included files it rendered the literal text "None" into every prompt.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { AgentCompletion } from "./agentCompletion/types.js";
import { getSettings } from "./config/settings.js";
import { getLogger, type Logger } from "./logger.js";
import { getCodeLanguage } from "./utils/language.js";
import { asRecord, loadYaml } from "./utils/loadYaml.js";
import { pyJsonDumps } from "./utils/pyCompat.js";

export interface GeneratedTest {
  test_behavior?: string;
  test_name?: string;
  test_code?: string;
  new_imports_code?: string;
  test_tags?: string;
  lines_to_cover?: string;
  [key: string]: unknown;
}

export interface FailedTestRun {
  code: GeneratedTest;
  errorMessage: string;
}

export interface GeneratedTests {
  language?: string;
  existing_test_function_signature?: string;
  new_tests: GeneratedTest[];
}

export interface UnitTestGeneratorOptions {
  sourceFilePath: string;
  testFilePath: string;
  projectRoot?: string;
  agentCompletion: AgentCompletion;
  includedFilesContent?: string;
  additionalInstructions?: string;
  logger?: Logger;
}

export const numberLines = (text: string): string =>
  text
    .split("\n")
    .map((line, i) => `${i + 1} ${line}`)
    .join("\n");

export class UnitTestGenerator {
  readonly sourceFilePath: string;
  readonly testFilePath: string;
  readonly projectRoot: string;
  readonly language: string;
  totalInputTokenCount = 0;
  totalOutputTokenCount = 0;
  /** The user prompt of the most recent generation, stored alongside attempts in the DB. */
  prompt = "";

  private readonly agentCompletion: AgentCompletion;
  private readonly includedFilesContent: string;
  private readonly additionalInstructions: string;
  private readonly logger: Logger;
  private readonly sourceCode: string;

  constructor(o: UnitTestGeneratorOptions) {
    this.sourceFilePath = o.sourceFilePath;
    this.testFilePath = o.testFilePath;
    this.projectRoot = o.projectRoot ?? "";
    this.agentCompletion = o.agentCompletion;
    this.includedFilesContent = o.includedFilesContent ?? "";
    this.additionalInstructions = o.additionalInstructions ?? "";
    this.logger = o.logger ?? getLogger("unit_test_generator");
    this.language = getCodeLanguage(this.sourceFilePath);
    this.sourceCode = readFileSync(this.sourceFilePath, "utf8");
  }

  private rel(p: string): string {
    return relative(this.projectRoot || process.cwd(), p);
  }

  checkForFailedTestRuns(failedTestRuns: FailedTestRun[]): string {
    let out = "";
    try {
      for (const failed of failedTestRuns) {
        if (!failed.code || Object.keys(failed.code).length === 0) continue;
        out += `Failed Test:\n\`\`\`\n${pyJsonDumps(failed.code)}\n\`\`\`\n`;
        out += failed.errorMessage
          ? `Test execution error analysis:\n${failed.errorMessage}\n\n\n`
          : "\n\n";
      }
    } catch (e) {
      this.logger.error(`Error processing failed test runs: ${String(e)}`);
      return "";
    }
    return out;
  }

  async generateTests(
    failedTestRuns: FailedTestRun[],
    language: string,
    testingFramework: string,
    codeCoverageReport: string,
  ): Promise<GeneratedTests> {
    const maxTests = Number(getSettings().default.max_tests_per_run ?? 4);
    const testCode = readFileSync(this.testFilePath, "utf8");

    const result = await this.agentCompletion.generateTests({
      sourceFileName: this.rel(this.sourceFilePath),
      maxTests,
      sourceFileNumbered: numberLines(this.sourceCode),
      codeCoverageReport,
      additionalInstructionsText: this.additionalInstructions,
      additionalIncludesSection: this.includedFilesContent,
      language,
      testFile: testCode,
      failedTestsSection: this.checkForFailedTestRuns(failedTestRuns),
      testFileName: this.rel(this.testFilePath),
      testingFramework,
    });
    this.prompt = result.prompt;
    this.totalInputTokenCount += result.promptTokens;
    this.totalOutputTokenCount += result.completionTokens;

    try {
      const parsed = asRecord(
        loadYaml(result.response, ["test_tags", "test_code", "test_name", "test_behavior"]),
      );
      if (!parsed) return { new_tests: [] };
      const newTests = Array.isArray(parsed["new_tests"])
        ? (parsed["new_tests"].filter((t) => asRecord(t)) as GeneratedTest[])
        : [];
      return { ...parsed, new_tests: newTests };
    } catch (e) {
      this.logger.error(`Error during test generation: ${String(e)}`);
      return { new_tests: [] };
    }
  }
}
