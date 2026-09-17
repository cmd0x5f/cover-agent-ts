/**
 * Port of cover_agent/main.py — same flags, same defaults (from settings/configuration.toml).
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { buildConfig, COVERAGE_TYPES, type CoverageType } from "./config/schema.js";
import { getSettings } from "./config/settings.js";
import { CoverAgent } from "./coverAgent.js";
import { configureLogging } from "./logger.js";
import { VERSION } from "./version.js";

function int(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new InvalidArgumentError("Not a number.");
  return n;
}

export function buildProgram(): Command {
  const d = getSettings().default;
  const program = new Command();
  program
    .name("cover-agent")
    .description(`Cover Agent v${VERSION}`)
    .version(VERSION)
    .requiredOption("--source-file-path <path>", "Path to the source file.")
    .requiredOption("--test-file-path <path>", "Path to the input test file.")
    .option("--project-root <path>", "Path to the root of the project.", "")
    .option("--test-file-output-path <path>", "Path to the output test file.", "")
    .requiredOption("--code-coverage-report-path <path>", "Path to the code coverage report file.")
    .requiredOption("--test-command <command>", "The command to run tests and generate coverage report.")
    .option("--test-command-dir <dir>", "The directory to run the test command in.", process.cwd())
    .option("--included-files <files...>", "List of files to include in the prompt as context.")
    .addOption(
      new Option("--coverage-type <type>", "Type of coverage report.")
        .choices([...COVERAGE_TYPES])
        .default(d.coverage_type),
    )
    .option("--report-filepath <path>", "Path to the output report file.", d.report_filepath)
    .option("--desired-coverage <n>", "The desired coverage percentage.", int, d.desired_coverage)
    .option("--max-iterations <n>", "The maximum number of iterations.", int, d.max_iterations)
    .option("--max-run-time-sec <n>", "Maximum time (in seconds) allowed for test execution.", int, d.max_run_time_sec)
    .option("--additional-instructions <text>", "Additional instructions appended at the end of the prompt.", "")
    .option("--model <model>", "Which LLM model to use, as <provider>/<model-id>.", d.model)
    .option("--api-base <url>", "The API url for Ollama or OpenAI-compatible endpoints.", d.api_base)
    .option("--strict-coverage", "Exit with code 2 if the desired coverage is not achieved.", false)
    .option("--run-tests-multiple-times <n>", "Number of times to run the generated tests.", int, d.run_tests_multiple_times)
    .option("--log-db-path <path>", "Path to optional log database.", process.env["LOG_DB_PATH"] || d.log_db_path)
    .option("--branch <branch>", "The branch to compare against when using --diff-coverage.", d.branch)
    .option("--run-each-test-separately", "Run each test separately.", false)
    .option("--record-mode", "Enable record mode for LLM responses.", false)
    .option("--suppress-log-files", "Suppress all generated log files (HTML, logs, DB files).", false)
    .addOption(
      new Option(
        "--use-report-coverage-feature-flag",
        "Consider coverage of all files in the report (a test is kept if it increases coverage anywhere).",
      ).conflicts("diffCoverage"),
    )
    .addOption(
      new Option("--diff-coverage", "Only generate tests for lines changed relative to --branch.").conflicts(
        "useReportCoverageFeatureFlag",
      ),
    );
  return program;
}

export async function main(argv = process.argv): Promise<number> {
  const program = buildProgram();
  program.parse(argv);
  const o = program.opts<Record<string, unknown>>();

  const config = buildConfig({
    sourceFilePath: o["sourceFilePath"] as string,
    testFilePath: o["testFilePath"] as string,
    projectRoot: o["projectRoot"] as string,
    testFileOutputPath: o["testFileOutputPath"] as string,
    codeCoverageReportPath: o["codeCoverageReportPath"] as string,
    testCommand: o["testCommand"] as string,
    testCommandDir: o["testCommandDir"] as string,
    includedFiles: (o["includedFiles"] as string[] | undefined) ?? [],
    coverageType: o["coverageType"] as CoverageType,
    reportFilepath: o["reportFilepath"] as string,
    desiredCoverage: o["desiredCoverage"] as number,
    maxIterations: o["maxIterations"] as number,
    maxRunTimeSec: o["maxRunTimeSec"] as number,
    additionalInstructions: o["additionalInstructions"] as string,
    model: o["model"] as string,
    apiBase: o["apiBase"] as string,
    strictCoverage: Boolean(o["strictCoverage"]),
    runTestsMultipleTimes: o["runTestsMultipleTimes"] as number,
    logDbPath: o["logDbPath"] as string,
    branch: o["branch"] as string,
    useReportCoverageFeatureFlag: Boolean(o["useReportCoverageFeatureFlag"]),
    diffCoverage: Boolean(o["diffCoverage"]),
    runEachTestSeparately: Boolean(o["runEachTestSeparately"]),
    recordMode: Boolean(o["recordMode"]),
    suppressLogFiles: Boolean(o["suppressLogFiles"]),
  });

  configureLogging({
    generateLogFiles: !config.suppressLogFiles,
    logFilePath: getSettings().default.log_file_path,
  });

  const agent = await CoverAgent.create(config);
  const result = await agent.run();
  return result.exitCode;
}

