/**
 * End-to-end: the full CoverAgent loop against a real Vitest + Istanbul project.
 * The LLM is scripted, everything else (test runs, Cobertura parsing, insertion, rollback,
 * attempts DB, HTML report) is real.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { CoverAgent } from "../src/coverAgent.js";
import { configureLogging } from "../src/logger.js";
import { UnitTestDB } from "../src/unitTestDb.js";
import { generatedTestsYaml, ScriptedAgentCompletion } from "./helpers/fakes.js";
import { makeTmpDir } from "./helpers/tmp.js";

const FIX = join(import.meta.dirname, "fixtures", "vitest-istanbul");

describe("CoverAgent e2e with Vitest + Istanbul", () => {
  it("keeps only passing, coverage-increasing tests and reaches the target", async () => {
    // Inside the repo so `npx vitest` resolves this package's node_modules.
    const root = makeTmpDir(join(import.meta.dirname, ".tmp"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    copyFileSync(join(FIX, "pricing.ts"), join(root, "src/pricing.ts"));
    copyFileSync(join(FIX, "pricing.test.ts"), join(root, "tests/pricing.test.ts"));
    copyFileSync(join(FIX, "vitest.config.ts"), join(root, "vitest.config.ts"));

    const iteration1 = generatedTestsYaml([
      { name: "wrong expectation", code: 'it("premium is free", () => {\n  expect(transferFee(10_000, "premium", false)).toBe(50);\n});' },
      { name: "international", code: 'it("adds 1% for international", () => {\n  expect(transferFee(10_000, "basic", true)).toBe(150);\n});' },
      { name: "duplicate", code: 'it("basic again", () => {\n  expect(transferFee(500, "basic", false)).toBe(50);\n});' },
    ]);
    const iteration2 = generatedTestsYaml([
      { name: "throws", code: 'it("rejects non-positive amounts", () => {\n  expect(() => transferFee(0, "basic", false)).toThrow("amount must be positive");\n});' },
      { name: "cap", code: 'it("caps the fee", () => {\n  expect(transferFee(10_000_000, "premium", true)).toBe(2500);\n});' },
    ]);
    const completion = new ScriptedAgentCompletion({
      indentation: 2,
      insertTestsAfter: 7,
      insertImportsAfter: 2,
      generateResponses: [iteration1, iteration2],
      failureAnalysis: "expected 0 to be 50: premium tier has no flat fee",
    });

    configureLogging({ generateLogFiles: false, silent: true });
    const config = buildConfig({
      sourceFilePath: join(root, "src/pricing.ts"),
      testFilePath: join(root, "tests/pricing.test.ts"),
      projectRoot: root,
      codeCoverageReportPath: join(root, "coverage/cobertura-coverage.xml"),
      testCommand: "npx vitest run --coverage.enabled --coverage.thresholds.lines=0",
      testCommandDir: root,
      coverageType: "cobertura",
      desiredCoverage: 100,
      maxIterations: 3,
      maxRunTimeSec: 120,
      logDbPath: join(root, "runs.db"),
      reportFilepath: join(root, "report.html"),
      model: "scripted",
    });

    const agent = await CoverAgent.create(config, { agentCompletion: completion });
    const result = await agent.run();

    expect(result).toMatchObject({ exitCode: 0, targetReached: true, finalCoverage: 1 });

    const finalTests = readFileSync(join(root, "tests/pricing.test.ts"), "utf8");
    expect(finalTests).toContain("adds 1% for international");
    expect(finalTests).toContain("rejects non-positive amounts");
    expect(finalTests).toContain("caps the fee");
    expect(finalTests).not.toContain("premium is free");
    expect(finalTests).not.toContain("basic again");

    // Iteration 2 saw the tests kept in iteration 1 and the failure analysis (stale-file fix).
    const second = completion.generateCalls[1]!;
    expect(second.testFile).toContain("adds 1% for international");
    expect(second.failedTestsSection).toContain("premium tier has no flat fee");
    expect(second.codeCoverageReport).toMatch(/Lines missed: \[\d/);

    const db = new UnitTestDB(join(root, "runs.db"));
    expect(db.getAllAttempts().map((a) => a.status)).toEqual(["FAIL", "PASS", "FAIL", "PASS", "PASS"]);
    db.close();
    expect(existsSync(join(root, "report.html"))).toBe(true);
  }, 240_000);
});
