/**
 * Port of cover_agent/agent_completion_abc.py
 *
 * Python returned 4-tuples (response, prompt_tokens, completion_tokens, prompt_user).
 * Here every method resolves to a named object instead.
 */
export interface CompletionResult<T = string> {
  response: T;
  promptTokens: number;
  completionTokens: number;
  /** The rendered user prompt (stored in the attempts DB). */
  prompt: string;
}

export interface GenerateTestsArgs {
  sourceFileName: string;
  maxTests: number;
  sourceFileNumbered: string;
  codeCoverageReport: string;
  language: string;
  testFile: string;
  testFileName: string;
  testingFramework: string;
  additionalInstructionsText?: string;
  additionalIncludesSection?: string;
  failedTestsSection?: string;
}

export interface AnalyzeTestFailureArgs {
  sourceFileName: string;
  sourceFile: string;
  processedTestFile: string;
  stdout: string;
  stderr: string;
  testFileName: string;
}

export interface AnalyzeTestInsertLineArgs {
  language: string;
  testFileNumbered: string;
  testFileName: string;
  additionalInstructionsText?: string;
}

export interface AnalyzeTestAgainstContextArgs {
  language: string;
  testFileContent: string;
  testFileNameRel: string;
  contextFilesNamesRel: string;
}

export interface AnalyzeSuiteTestHeadersIndentationArgs {
  language: string;
  testFileName: string;
  testFile: string;
}

export interface AdaptTestCommandArgs {
  testFileRelativePath: string;
  testCommand: string;
  projectRootDir: string;
}

export interface AgentCompletion {
  generateTests(args: GenerateTestsArgs): Promise<CompletionResult>;
  analyzeTestFailure(args: AnalyzeTestFailureArgs): Promise<CompletionResult>;
  analyzeTestInsertLine(args: AnalyzeTestInsertLineArgs): Promise<CompletionResult>;
  analyzeTestAgainstContext(args: AnalyzeTestAgainstContextArgs): Promise<CompletionResult>;
  analyzeSuiteTestHeadersIndentation(
    args: AnalyzeSuiteTestHeadersIndentationArgs,
  ): Promise<CompletionResult>;
  /** Resolves `response: null` when the model output could not be parsed. */
  adaptTestCommandForASingleTestViaAi(
    args: AdaptTestCommandArgs,
  ): Promise<CompletionResult<string | null>>;
}
