/**
 * Parity with the Python tool: prompts rendered by Nunjucks must be byte-identical to the
 * prompts Jinja2 rendered for upstream's recorded typescript_calculator run, and the
 * record/replay hash of those prompts must match the hashes Python wrote to disk.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/agentCompletion/defaultAgentCompletion.js";
import { promptHash } from "../src/ai/recordReplayManager.js";
import { numberLines } from "../src/unitTestGenerator.js";
import { safeLoad } from "../src/utils/loadYaml.js";

const FIX = join(import.meta.dirname, "fixtures", "upstream-typescript-calculator");
const recording = safeLoad(
  readFileSync(join(FIX, "typescript_calculator_responses_59a42f4afe25.yml"), "utf8"),
) as Record<string, Record<string, { prompt: { system: string; user: string } }>>;
const testFile = readFileSync(join(FIX, "Calculator.test.ts"), "utf8");
const sourceFile = readFileSync(join(FIX, "Calculator.ts"), "utf8");
const only = (caller: string) => Object.entries(recording[caller]!)[0]!;

describe("prompt rendering parity with Jinja2", () => {
  it("analyze_suite_test_headers_indentation", () => {
    const [hash, entry] = only("analyze_suite_test_headers_indentation");
    const p = buildPrompt("analyze_suite_test_headers_indentation", {
      language: "typescript",
      test_file_name: "tests/Calculator.test.ts",
      test_file: testFile,
    });
    expect(p).toEqual(entry.prompt);
    expect(promptHash(p, 12)).toBe(hash);
  });

  it("analyze_suite_test_insert_line", () => {
    const [hash, entry] = only("analyze_test_insert_line");
    const p = buildPrompt("analyze_suite_test_insert_line", {
      language: "typescript",
      test_file_numbered: numberLines(testFile),
      test_file_name: "tests/Calculator.test.ts",
      additional_instructions_text: "",
    });
    expect(p).toEqual(entry.prompt);
    expect(promptHash(p, 12)).toBe(hash);
  });

  it("test_generation_prompt (the most complex template)", () => {
    const [hash, entry] = only("generate_tests");
    const recordedUser = entry.prompt.user;
    // Reuse the recorded coverage section (Python emitted set-ordered line numbers) and the
    // literal "None" includes section upstream rendered, to isolate template behaviour.
    const coverageBody = recordedUser.slice(recordedUser.indexOf("## Code Coverage")).split("=========\n")[1]!.replace(/\n$/, "");
    const p = buildPrompt("test_generation_prompt", {
      source_file_name: "src/modules/Calculator.ts",
      max_tests: 4,
      source_file_numbered: numberLines(sourceFile),
      code_coverage_report: coverageBody,
      language: "typescript",
      test_file: testFile,
      test_file_name: "tests/Calculator.test.ts",
      testing_framework: "mocha",
      additional_instructions_text: "",
      additional_includes_section: "None",
      failed_tests_section: "",
    });
    expect(p.user).toBe(recordedUser);
    expect(promptHash(p, 12)).toBe(hash);
  });

  it("omits optional sections when they are empty", () => {
    const p = buildPrompt("test_generation_prompt", {
      source_file_name: "a.ts",
      max_tests: 4,
      source_file_numbered: "1 x",
      code_coverage_report: "Lines covered: []",
      language: "typescript",
      test_file: "",
      test_file_name: "a.test.ts",
      testing_framework: "vitest",
      additional_instructions_text: "",
      additional_includes_section: "",
      failed_tests_section: "",
    });
    expect(p.user).not.toContain("## Additional Includes");
    expect(p.user).not.toContain("## Previous Iterations Failed Tests");
    expect(p.user).not.toContain("lines_to_cover"); // python/java-only field
  });

  it("throws on missing template variables (StrictUndefined)", () => {
    expect(() => buildPrompt("analyze_suite_test_headers_indentation", { language: "typescript" })).toThrow(
      /Error rendering prompt/,
    );
  });
});
