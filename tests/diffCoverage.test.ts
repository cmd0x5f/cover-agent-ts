import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeDiffCoverage, getChangedLines, parseUnifiedDiff } from "../src/coverage/diffCoverage.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,0 +4,3 @@ export function a() {
+  one
+  two
+  three
@@ -10 +13 @@
-old
+new
@@ -20,2 +22,0 @@
-gone
-gone
diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
`;

describe("parseUnifiedDiff", () => {
  it("collects added/modified lines and ignores deletions", () => {
    const parsed = parseUnifiedDiff(DIFF);
    expect([...parsed.get("src/a.ts")!].sort((a, b) => a - b)).toEqual([4, 5, 6, 13]);
    expect(parsed.has("src/deleted.ts")).toBe(false);
  });
});

describe("getChangedLines", () => {
  it("unions branch, staged and unstaged diffs and resolves against the repo root", async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse") return "/repo\n";
      if (args.includes("main...HEAD")) return "+++ b/src/a.ts\n@@ -1 +1 @@\n";
      if (args.includes("--cached")) return "+++ b/src/a.ts\n@@ -1 +2,2 @@\n";
      return "+++ b/src/b.ts\n@@ -1 +9 @@\n";
    };
    const changed = await getChangedLines("main", "/repo/pkg", git);
    expect([...changed.get(resolve("/repo/src/a.ts"))!].sort()).toEqual([1, 2, 3]);
    expect([...changed.get(resolve("/repo/src/b.ts"))!]).toEqual([9]);
    expect(calls).toHaveLength(4);
  });
});

describe("computeDiffCoverage", () => {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };

  it("only counts measurable changed lines", () => {
    const changed = new Map([[resolve("src/a.ts"), new Set([4, 5, 6, 13])]]);
    const cov = computeDiffCoverage({ linesCovered: [1, 4], linesMissed: [5, 6], percentageCovered: 0.5 }, changed, "src/a.ts", silent);
    // line 13 is not executable (not in the report) so it is ignored
    expect(cov).toEqual({ linesCovered: [4], linesMissed: [5, 6], percentageCovered: 1 / 3 });
  });

  it("treats an unchanged source file as fully covered", () => {
    const cov = computeDiffCoverage({ linesCovered: [], linesMissed: [1], percentageCovered: 0 }, new Map(), "src/a.ts", silent);
    expect(cov.percentageCovered).toBe(1);
  });
});
