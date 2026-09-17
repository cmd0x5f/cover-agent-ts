import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffLines, ReportGenerator } from "../src/reportGenerator.js";
import { UnitTestDB } from "../src/unitTestDb.js";
import { makeTmpDir } from "./helpers/tmp.js";

describe("ReportGenerator", () => {
  it("escapes JSX so generated React tests do not break the report", () => {
    const html = ReportGenerator.renderReport([
      {
        status: "PASS", reason: "", exitCode: 0, stderr: "<script>alert(1)</script>", stdout: "",
        testCode: "render(<Button label=\"x\" />)", imports: "", language: "typescript",
        originalTestFile: "a", processedTestFile: "a\n<Button />",
      },
    ]);
    expect(html).not.toContain("<Button");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;Button label=&quot;x&quot; /&gt;");
    expect(html).toContain('class="status-pass"');
  });

  it("diffLines produces a minimal line diff", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { op: " ", line: "a" }, { op: "-", line: "b" }, { op: "+", line: "x" }, { op: " ", line: "c" }, { op: "+", line: "d" },
    ]);
  });
});

describe("UnitTestDB", () => {
  it("stores attempts with the upstream schema and renders a report", () => {
    const dir = makeTmpDir();
    const db = new UnitTestDB(join(dir, "runs.db"));
    const id = db.insertAttempt({
      status: "FAIL", reason: "Test failed", exitCode: 1, stderr: "err", stdout: "out",
      test: { test_code: "it('x')", new_imports_code: "import x" }, language: "typescript",
      sourceFile: "src", originalTestFile: "orig", processedTestFile: "processed", prompt: "the prompt",
    });
    expect(id).toBe(1);
    expect(db.getAllAttempts()[0]).toMatchObject({ id: 1, status: "FAIL", testCode: "it('x')", imports: "import x", prompt: "the prompt" });
    db.dumpToReport(join(dir, "report.html"));
    db.close();
    expect(readFileSync(join(dir, "report.html"), "utf8")).toContain("Test failed");
  });
});
