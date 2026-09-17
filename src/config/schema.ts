/**
 * Port of cover_agent/settings/config_schema.py
 *
 * The full-repo-only fields (max_test_files_allowed_to_analyze,
 * look_for_oldest_unchanged_test_file, project_language) are intentionally omitted:
 * full-repo mode depends on a Python-only LSP stack and was not ported.
 */
import { getSettings } from "./settings.js";

export const COVERAGE_TYPES = ["cobertura", "lcov", "jacoco"] as const;
export type CoverageType = (typeof COVERAGE_TYPES)[number];

export interface CoverAgentConfig {
  sourceFilePath: string;
  testFilePath: string;
  projectRoot: string;
  testFileOutputPath: string;
  codeCoverageReportPath: string;
  testCommand: string;
  testCommandDir: string;
  includedFiles: string[];
  coverageType: CoverageType;
  reportFilepath: string;
  desiredCoverage: number;
  maxIterations: number;
  maxRunTimeSec: number;
  additionalInstructions: string;
  model: string;
  apiBase: string;
  strictCoverage: boolean;
  runTestsMultipleTimes: number;
  logDbPath: string;
  branch: string;
  useReportCoverageFeatureFlag: boolean;
  diffCoverage: boolean;
  runEachTestSeparately: boolean;
  recordMode: boolean;
  suppressLogFiles: boolean;
  testCommandOriginal?: string;
}

export type CoverAgentConfigInput = Pick<
  CoverAgentConfig,
  "sourceFilePath" | "testFilePath" | "codeCoverageReportPath" | "testCommand"
> &
  Partial<CoverAgentConfig>;

/**
 * Equivalent of CoverAgentConfig.from_cli_args_with_defaults: explicit values win,
 * anything undefined falls back to settings/configuration.toml.
 */
export function buildConfig(input: CoverAgentConfigInput): CoverAgentConfig {
  const d = getSettings().default;
  const coverageType = (input.coverageType ?? d.coverage_type) as string;
  if (!COVERAGE_TYPES.includes(coverageType as CoverageType)) {
    throw new Error(
      `Unsupported coverage type "${coverageType}". Expected one of: ${COVERAGE_TYPES.join(", ")}`,
    );
  }
  if (input.diffCoverage && input.useReportCoverageFeatureFlag) {
    throw new Error("--diff-coverage is not compatible with --use-report-coverage-feature-flag");
  }

  return {
    sourceFilePath: input.sourceFilePath,
    testFilePath: input.testFilePath,
    projectRoot: input.projectRoot ?? "",
    testFileOutputPath: input.testFileOutputPath ?? "",
    codeCoverageReportPath: input.codeCoverageReportPath,
    testCommand: input.testCommand,
    testCommandDir: input.testCommandDir ?? process.cwd(),
    includedFiles: input.includedFiles ?? [],
    coverageType: coverageType as CoverageType,
    reportFilepath: input.reportFilepath ?? d.report_filepath,
    desiredCoverage: input.desiredCoverage ?? d.desired_coverage,
    maxIterations: input.maxIterations ?? d.max_iterations,
    maxRunTimeSec: input.maxRunTimeSec ?? d.max_run_time_sec,
    additionalInstructions: input.additionalInstructions ?? "",
    model: input.model ?? d.model,
    apiBase: input.apiBase ?? d.api_base,
    strictCoverage: input.strictCoverage ?? false,
    runTestsMultipleTimes: input.runTestsMultipleTimes ?? d.run_tests_multiple_times,
    logDbPath: process.env["LOG_DB_PATH"] || input.logDbPath || d.log_db_path,
    branch: input.branch ?? d.branch,
    useReportCoverageFeatureFlag: input.useReportCoverageFeatureFlag ?? false,
    diffCoverage: input.diffCoverage ?? false,
    runEachTestSeparately: input.runEachTestSeparately ?? false,
    recordMode: input.recordMode ?? false,
    suppressLogFiles: input.suppressLogFiles ?? false,
    ...(input.testCommandOriginal !== undefined
      ? { testCommandOriginal: input.testCommandOriginal }
      : {}),
  };
}
