/**
 * Port of cover_agent/default_agent_completion.py
 *
 * Prompts are the upstream TOML files, unchanged. Jinja2 is replaced by Nunjucks, configured
 * to render byte-identical output for these templates (verified in tests/prompts.test.ts
 * against prompts recorded by the Python tool):
 * - autoescape off (Jinja2 Environment default)
 * - throwOnUndefined (StrictUndefined)
 * - one trailing newline stripped from the template (Jinja2 keep_trailing_newline=False)
 */
import nunjucks from "nunjucks";
import { getPromptTemplate } from "../config/settings.js";
import { getLogger, type Logger } from "../logger.js";
import type { ModelCaller, Prompt } from "../ai/types.js";
import { asRecord, loadYaml } from "../utils/loadYaml.js";
import type {
  AdaptTestCommandArgs,
  AgentCompletion,
  AnalyzeSuiteTestHeadersIndentationArgs,
  AnalyzeTestAgainstContextArgs,
  AnalyzeTestFailureArgs,
  AnalyzeTestInsertLineArgs,
  CompletionResult,
  GenerateTestsArgs,
} from "./types.js";

const env = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: true,
  trimBlocks: false,
  lstripBlocks: false,
});

function jinjaCompat(template: string): string {
  return template.endsWith("\n") ? template.slice(0, -1) : template;
}

export function buildPrompt(file: string, vars: Record<string, unknown>): Prompt {
  const template = getPromptTemplate(file);
  try {
    return {
      system: env.renderString(jinjaCompat(template.system), vars),
      user: env.renderString(jinjaCompat(template.user), vars),
    };
  } catch (e) {
    throw new Error(`Error rendering prompt for '${file}': ${String(e)}`);
  }
}

export class DefaultAgentCompletion implements AgentCompletion {
  private readonly logger: Logger;

  constructor(
    private readonly caller: ModelCaller,
    logger?: Logger,
  ) {
    this.logger = logger ?? getLogger("default_agent_completion");
  }

  private async run(
    callerName: string,
    file: string,
    vars: Record<string, unknown>,
  ): Promise<CompletionResult> {
    let prompt: Prompt;
    try {
      prompt = buildPrompt(file, vars);
    } catch (e) {
      this.logger.error(String(e));
      throw e;
    }
    const r = await this.caller.callModel(prompt, callerName);
    return {
      response: r.content,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      prompt: prompt.user,
    };
  }

  generateTests(a: GenerateTestsArgs): Promise<CompletionResult> {
    return this.run("generate_tests", "test_generation_prompt", {
      source_file_name: a.sourceFileName,
      max_tests: a.maxTests,
      source_file_numbered: a.sourceFileNumbered,
      code_coverage_report: a.codeCoverageReport,
      language: a.language,
      test_file: a.testFile,
      test_file_name: a.testFileName,
      testing_framework: a.testingFramework,
      additional_instructions_text: a.additionalInstructionsText ?? "",
      additional_includes_section: a.additionalIncludesSection ?? "",
      failed_tests_section: a.failedTestsSection ?? "",
    });
  }

  analyzeTestFailure(a: AnalyzeTestFailureArgs): Promise<CompletionResult> {
    return this.run("analyze_test_failure", "analyze_test_run_failure", {
      source_file_name: a.sourceFileName,
      source_file: a.sourceFile,
      processed_test_file: a.processedTestFile,
      stdout: a.stdout,
      stderr: a.stderr,
      test_file_name: a.testFileName,
    });
  }

  analyzeTestInsertLine(a: AnalyzeTestInsertLineArgs): Promise<CompletionResult> {
    return this.run("analyze_test_insert_line", "analyze_suite_test_insert_line", {
      language: a.language,
      test_file_numbered: a.testFileNumbered,
      test_file_name: a.testFileName,
      additional_instructions_text: a.additionalInstructionsText ?? "",
    });
  }

  analyzeTestAgainstContext(a: AnalyzeTestAgainstContextArgs): Promise<CompletionResult> {
    return this.run("analyze_test_against_context", "analyze_test_against_context", {
      language: a.language,
      test_file_content: a.testFileContent,
      test_file_name_rel: a.testFileNameRel,
      context_files_names_rel: a.contextFilesNamesRel,
    });
  }

  analyzeSuiteTestHeadersIndentation(
    a: AnalyzeSuiteTestHeadersIndentationArgs,
  ): Promise<CompletionResult> {
    return this.run(
      "analyze_suite_test_headers_indentation",
      "analyze_suite_test_headers_indentation",
      { language: a.language, test_file_name: a.testFileName, test_file: a.testFile },
    );
  }

  async adaptTestCommandForASingleTestViaAi(
    a: AdaptTestCommandArgs,
  ): Promise<CompletionResult<string | null>> {
    const result = await this.run(
      "adapt_test_command_for_a_single_test_via_ai",
      "adapt_test_command_for_a_single_test_via_ai",
      {
        test_file_relative_path: a.testFileRelativePath,
        test_command: a.testCommand,
        project_root_dir: a.projectRootDir,
      },
    );
    let newCommandLine: string | null = null;
    try {
      const value = asRecord(loadYaml(result.response))?.["new_command_line"];
      if (typeof value === "string") newCommandLine = value.trim();
    } catch (e) {
      this.logger.error(
        `Failed parsing YAML for adapt_test_command. response_yaml: ${result.response}. Error: ${String(e)}`,
      );
    }
    return { ...result, response: newCommandLine };
  }
}
