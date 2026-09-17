/** Ported and extended from upstream tests/test_unit_test_validator.py */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnitTestValidator } from "../src/unitTestValidator.js";
import { queuedRunner, ScriptedAgentCompletion } from "./helpers/fakes.js";
import { makeTmpDir, writeFiles } from "./helpers/tmp.js";

const SOURCE = "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n";
const TEST_FILE = [
  'import { describe, it, expect } from "vitest";',
  'import { add } from "../src/math";',
  "",
  'describe("math", () => {',
  '  it("adds", () => {',
  "    expect(add(1, 2)).toBe(3);",
  "  });",
  "});",
  "",
].join("\n");

function setup(options: { runnerResults: Parameters<typeof queuedRunner>[0]; completion?: ScriptedAgentCompletion; flags?: object }) {
  const root = makeTmpDir();
  writeFiles(root, { "src/math.ts": SOURCE, "tests/math.test.ts": TEST_FILE });
  const report = join(root, "lcov.info");
  const lcov = (hits: number[]) =>
    writeFileSync(report, [`SF:${join(root, "src/math.ts")}`, ...hits.map((h, i) => `DA:${i + 1},${h}`), "end_of_record"].join("\n"));
  const completion = options.completion ?? new ScriptedAgentCompletion({ indentation: 2, insertTestsAfter: 7, insertImportsAfter: 2 });
  const runner = queuedRunner(options.runnerResults.map((r) => ({ ...r, effect: r.effect ?? (() => {}) })));
  const validator = new UnitTestValidator({
    sourceFilePath: join(root, "src/math.ts"),
    testFilePath: join(root, "tests/math.test.ts"),
    codeCoverageReportPath: report,
    testCommand: "npx vitest run",
    testCommandDir: root,
    coverageType: "lcov",
    desiredCoverage: 100,
    maxRunTimeSec: 10,
    agentCompletion: completion,
    projectRoot: root,
    runner,
    ...options.flags,
  });
  return { root, validator, runner, completion, lcov, testPath: join(root, "tests/math.test.ts") };
}

describe("initialTestSuiteAnalysis", () => {
  it("stores indentation, insertion lines and framework", async () => {
    const { validator } = setup({ runnerResults: [{}] });
    await validator.initialTestSuiteAnalysis();
    expect(validator.testHeadersIndentation).toBe(2);
    expect(validator.relevantLineNumberToInsertTestsAfter).toBe(7);
    expect(validator.relevantLineNumberToInsertImportsAfter).toBe(2);
    expect(validator.testingFramework).toBe("vitest");
  });

  it("accepts an indentation of 0", async () => {
    const { validator } = setup({ runnerResults: [{}], completion: new ScriptedAgentCompletion({ indentation: 0 }) });
    await validator.initialTestSuiteAnalysis();
    expect(validator.testHeadersIndentation).toBe(0);
  });

  it("fails when the model never returns an insertion line", async () => {
    const { validator } = setup({ runnerResults: [{}], completion: new ScriptedAgentCompletion({ insertTestsAfter: null }) });
    await expect(validator.initialTestSuiteAnalysis()).rejects.toThrow("Error during initial test suite analysis");
  });
});

describe("runCoverage", () => {
  it("records baseline coverage and a Python-formatted coverage summary", async () => {
    const s = setup({ runnerResults: [{ effect: () => s.lcov([1, 0]) }] });
    await s.validator.runCoverage();
    expect(s.validator.currentCoverage).toBe(0.5);
    expect(s.validator.codeCoverageReport).toBe("Lines covered: [1]\nLines missed: [2]\nPercentage covered: 50.0%");
  });

  it("throws a fatal error when the test command fails", async () => {
    const { validator } = setup({ runnerResults: [{ exitCode: 1, stderr: "boom" }] });
    await expect(validator.runCoverage()).rejects.toThrow(/Fatal: Error running test command/);
  });
});

describe("validateTest", () => {
  const generated = {
    test_code: 'it("subtracts", () => {\n  expect(sub(3, 1)).toBe(2);\n});',
    new_imports_code: 'import { sub } from "../src/math";\nimport { describe, it, expect } from "vitest";',
  };

  it("keeps a passing test that increases coverage, inserting imports and re-indenting", async () => {
    const s = setup({ runnerResults: [{ effect: () => s.lcov([1, 0]) }, { effect: () => s.lcov([1, 1]) }] });
    await s.validator.initialTestSuiteAnalysis();
    await s.validator.runCoverage();

    const result = await s.validator.validateTest(generated);
    expect(result.status).toBe("PASS");
    const content = readFileSync(s.testPath, "utf8").split("\n");
    // duplicate vitest import skipped, new import inserted after line 2
    expect(content[2]).toBe('import { sub } from "../src/math";');
    expect(content.filter((l) => l.includes('from "vitest"'))).toHaveLength(1);
    // test inserted after original line 7 (+1 import line), indented by 2
    expect(content.slice(8, 12)).toEqual(["", '  it("subtracts", () => {', "    expect(sub(3, 1)).toBe(2);", "  });"]);
    expect(content[13]).toBe("});");
    expect(s.validator.currentCoverage).toBe(1);
    expect(s.validator.relevantLineNumberToInsertTestsAfter).toBe(8);
  });

  it("rolls back a failing test and asks the model why it failed", async () => {
    const s = setup({ runnerResults: [{ effect: () => s.lcov([1, 0]) }, { exitCode: 1, stderr: "AssertionError" }] });
    await s.validator.initialTestSuiteAnalysis();
    await s.validator.runCoverage();

    const result = await s.validator.validateTest(generated);
    expect(result).toMatchObject({ status: "FAIL", reason: "Test failed", exitCode: 1 });
    expect(readFileSync(s.testPath, "utf8")).toBe(TEST_FILE);
    expect(s.completion.failureAnalyses).toBe(1);
    expect(s.validator.failedTestRuns).toEqual([{ code: generated, errorMessage: "assertion failed" }]);
  });

  it("rolls back a passing test that does not increase coverage", async () => {
    const s = setup({ runnerResults: [{ effect: () => s.lcov([1, 0]) }, { effect: () => s.lcov([1, 0]) }] });
    await s.validator.initialTestSuiteAnalysis();
    await s.validator.runCoverage();

    const result = await s.validator.validateTest(generated);
    expect(result.status).toBe("FAIL");
    expect(result.reason).toMatch(/Coverage did not increase/);
    expect(readFileSync(s.testPath, "utf8")).toBe(TEST_FILE);
    expect(s.validator.failedTestRuns[0]!.errorMessage).toBe("Test did not increase code coverage");
  });

  it("runs the command run_tests_multiple_times and stops at the first failure", async () => {
    const s = setup({
      runnerResults: [{ effect: () => s.lcov([1, 0]) }, { effect: () => s.lcov([1, 1]) }, { exitCode: 1 }],
      flags: { numAttempts: 3 },
    });
    await s.validator.initialTestSuiteAnalysis();
    await s.validator.runCoverage();
    const result = await s.validator.validateTest(generated);
    expect(result.status).toBe("FAIL");
    expect(s.runner.calls).toHaveLength(3); // baseline + 2 attempts (second one failed)
  });

  it("returns FAIL instead of crashing when there is no insertion point", async () => {
    const { validator } = setup({ runnerResults: [{}] });
    const result = await validator.validateTest(generated);
    expect(result).toMatchObject({ status: "FAIL", processedTestFile: "N/A" });
  });
});

describe("postProcessCoverageReport modes", () => {
  it("diff coverage: measures only changed lines", async () => {
    const s = setup({
      runnerResults: [{ effect: () => s.lcov([0, 0]) }],
      flags: {
        diffCoverage: true,
        comparisonBranch: "main",
        git: async (args: string[]) =>
          args[0] === "rev-parse" ? `${s.root}\n` : args.includes("main...HEAD") ? "+++ b/src/math.ts\n@@ -1,0 +2 @@\n" : "",
      },
    });
    await s.validator.runCoverage();
    expect(s.validator.codeCoverageReport).toBe("Lines covered: []\nLines missed: [2]\nPercentage covered: 0.0%");
  });

  it("report coverage flag: aggregates all files", async () => {
    const s = setup({
      runnerResults: [
        {
          effect: () =>
            writeFileSync(join(s.root, "lcov.info"), "SF:a.ts\nDA:1,1\nDA:2,0\nend_of_record\nSF:b.ts\nDA:1,1\nend_of_record\n"),
        },
      ],
      flags: { useReportCoverageFeatureFlag: true },
    });
    await s.validator.runCoverage();
    expect(s.validator.currentCoverage).toBeCloseTo(2 / 3);
    expect(s.validator.lastCoveragePercentages).toEqual({ "a.ts": 0.5, "b.ts": 1 });
  });
});
