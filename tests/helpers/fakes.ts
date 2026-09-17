import type {
  AgentCompletion,
  CompletionResult,
  GenerateTestsArgs,
} from "../../src/agentCompletion/types.js";
import type { CommandResult, RunCommand } from "../../src/runner.js";

const result = <T>(response: T, prompt = "prompt"): CompletionResult<T> => ({
  response,
  promptTokens: 10,
  completionTokens: 5,
  prompt,
});

/** AgentCompletion with scripted YAML answers, recording what it was asked. */
export class ScriptedAgentCompletion implements AgentCompletion {
  generateCalls: GenerateTestsArgs[] = [];
  failureAnalyses = 0;

  constructor(
    private readonly script: {
      indentation?: number | null;
      insertTestsAfter?: number | null;
      insertImportsAfter?: number | null;
      framework?: string;
      generateResponses?: string[];
      failureAnalysis?: string;
      adaptedCommand?: string | null;
    } = {},
  ) {}

  async analyzeSuiteTestHeadersIndentation() {
    const v = this.script.indentation === undefined ? 2 : this.script.indentation;
    return result(`language: typescript\ntesting_framework: vitest\nnumber_of_tests: 1\ntest_headers_indentation: ${v ?? ""}`);
  }
  async analyzeTestInsertLine() {
    const t = this.script.insertTestsAfter === undefined ? 1 : this.script.insertTestsAfter;
    const i = this.script.insertImportsAfter === undefined ? 1 : this.script.insertImportsAfter;
    return result(
      `language: typescript\ntesting_framework: ${this.script.framework ?? "vitest"}\nnumber_of_tests: 1\n` +
        `relevant_line_number_to_insert_tests_after: ${t ?? ""}\nrelevant_line_number_to_insert_imports_after: ${i ?? ""}`,
    );
  }
  async generateTests(args: GenerateTestsArgs) {
    this.generateCalls.push(args);
    const responses = this.script.generateResponses ?? [];
    return result(responses[Math.min(this.generateCalls.length - 1, responses.length - 1)] ?? "", "generated-prompt");
  }
  async analyzeTestFailure() {
    this.failureAnalyses++;
    return result(this.script.failureAnalysis ?? "assertion failed");
  }
  async analyzeTestAgainstContext() {
    return result("is_this_a_unit_test: 1\nmain_file: x");
  }
  async adaptTestCommandForASingleTestViaAi() {
    return result(this.script.adaptedCommand ?? null);
  }
}

/** Runner that returns queued results (last one repeats) and runs an optional side effect. */
export function queuedRunner(
  results: Array<Partial<CommandResult> & { effect?: () => void }>,
): RunCommand & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (command: string) => {
    calls.push(command);
    const r = results[Math.min(i++, results.length - 1)]!;
    const commandStartTime = Date.now() - 1000;
    r.effect?.();
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0, commandStartTime };
  }) as unknown as RunCommand & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function generatedTestsYaml(
  tests: Array<{ name: string; code: string; imports?: string }>,
): string {
  const indent = (s: string, n: number) => s.split("\n").map((l) => " ".repeat(n) + l).join("\n");
  return (
    "```yaml\nlanguage: typescript\nexisting_test_function_signature: |\n  it('x', () => {\nnew_tests:\n" +
    tests
      .map(
        (t) =>
          `- test_behavior: |\n    ${t.name}\n  test_name: |\n    ${t.name}\n  test_code: |\n${indent(t.code, 4)}\n` +
          `  new_imports_code: |\n${indent(t.imports ?? '""', 4)}\n  test_tags: happy path`,
      )
      .join("\n") +
    "\n```"
  );
}
