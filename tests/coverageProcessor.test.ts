/** Ported and extended from upstream tests/test_coverage_processor.py */
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CoverageProcessor,
  CoverageReportMissingError,
  matchReportPath,
} from "../src/coverage/coverageProcessor.js";
import { makeTmpDir, writeFiles } from "./helpers/tmp.js";

const cobertura = (root: string) => `<?xml version="1.0" ?>
<coverage version="1">
  <sources><source>${root}</source></sources>
  <packages><package name="p"><classes>
    <class name="a" filename="packages/brand-a/src/index.ts"><lines>
      <line number="1" hits="1"/><line number="2" hits="0"/><line number="3" hits="1"/>
    </lines></class>
    <class name="b" filename="packages/brand-b/src/index.ts"><lines>
      <line number="1" hits="0"/><line number="2" hits="0"/>
    </lines></class>
    <class name="c" filename="src/MyCalculator.ts"><lines><line number="9" hits="1"/></lines></class>
    <class name="d" filename="src/Calculator.ts"><lines>
      <line number="5" hits="0"/><line number="4" hits="2"/>
    </lines></class>
    <class name="d2" filename="src/Calculator.ts"><lines>
      <line number="5" hits="3"/><line number="6" hits="0"/>
    </lines></class>
  </classes></package></packages>
</coverage>`;

describe("CoverageProcessor — Cobertura", () => {
  it("resolves monorepo files exactly instead of by basename", () => {
    const root = makeTmpDir();
    writeFiles(root, { "coverage.xml": cobertura(root) });
    const p = new CoverageProcessor({
      reportPath: join(root, "coverage.xml"),
      srcFilePath: join(root, "packages/brand-a/src/index.ts"),
      coverageType: "cobertura",
    });
    // Upstream (basename match) would have merged brand-a and brand-b -> 2/5.
    expect(p.parseCoverageReport()).toEqual({ linesCovered: [1, 3], linesMissed: [2], percentageCovered: 2 / 3 });
  });

  it("does not match MyCalculator.ts for Calculator.ts and merges split <class> entries", () => {
    const root = makeTmpDir();
    writeFiles(root, { "coverage.xml": cobertura(root) });
    const p = new CoverageProcessor({
      reportPath: join(root, "coverage.xml"),
      srcFilePath: join(root, "src/Calculator.ts"),
      coverageType: "cobertura",
    });
    expect(p.parseCoverageReport()).toEqual({ linesCovered: [4, 5], linesMissed: [6], percentageCovered: 2 / 3 });
  });

  it("returns 0% for a file that is not in the report", () => {
    const root = makeTmpDir();
    writeFiles(root, { "coverage.xml": cobertura(root) });
    const p = new CoverageProcessor({
      reportPath: join(root, "coverage.xml"),
      srcFilePath: join(root, "src/nope.ts"),
      coverageType: "cobertura",
    });
    expect(p.parseCoverageReport()).toEqual({ linesCovered: [], linesMissed: [], percentageCovered: 0 });
  });

  it("parses all files for --use-report-coverage-feature-flag", () => {
    const root = makeTmpDir();
    writeFiles(root, { "coverage.xml": cobertura(root) });
    const p = new CoverageProcessor({ reportPath: join(root, "coverage.xml"), srcFilePath: "x", coverageType: "cobertura" });
    const all = p.parseAllFiles();
    expect([...all.keys()].sort()).toEqual([
      "packages/brand-a/src/index.ts",
      "packages/brand-b/src/index.ts",
      "src/Calculator.ts",
      "src/MyCalculator.ts",
    ]);
    expect(all.get("packages/brand-b/src/index.ts")!.percentageCovered).toBe(0);
  });
});

describe("CoverageProcessor — LCOV", () => {
  const lcov = (root: string) =>
    [
      `SF:${root}/src/a.ts`, "DA:1,1", "DA:2,0", "DA:3,5", "end_of_record",
      "SF:src/other/a.ts", "DA:1,0", "end_of_record",
    ].join("\n");

  it("parses coverage for the source file (absolute SF)", () => {
    const root = makeTmpDir();
    writeFiles(root, { "lcov.info": lcov(root) });
    const p = new CoverageProcessor({ reportPath: join(root, "lcov.info"), srcFilePath: join(root, "src/a.ts"), coverageType: "lcov" });
    expect(p.parseCoverageReport()).toEqual({ linesCovered: [1, 3], linesMissed: [2], percentageCovered: 2 / 3 });
  });

  it("supports the report-coverage feature flag (crashed upstream)", () => {
    const root = makeTmpDir();
    writeFiles(root, { "lcov.info": lcov(root) });
    const p = new CoverageProcessor({ reportPath: join(root, "lcov.info"), srcFilePath: "x", coverageType: "lcov" });
    expect(p.parseAllFiles().size).toBe(2);
  });

  it("returns empty coverage for a report without data", () => {
    const root = makeTmpDir();
    writeFiles(root, { "lcov.info": "" });
    const p = new CoverageProcessor({ reportPath: join(root, "lcov.info"), srcFilePath: join(root, "a.ts"), coverageType: "lcov" });
    expect(p.parseCoverageReport().percentageCovered).toBe(0);
  });
});

describe("CoverageProcessor — JaCoCo (ported as-is)", () => {
  it("parses XML for a Java class", () => {
    const root = makeTmpDir();
    writeFiles(root, {
      "src/Calc.java": "package com.example;\n\npublic class Calc {\n}\n",
      "jacoco.xml": `<report name="r"><package name="com/example"><sourcefile name="Calc.java">
        <line nr="3" mi="0" ci="2"/><line nr="4" mi="1" ci="0"/><line nr="5" mi="0" ci="1"/>
      </sourcefile></package></report>`,
    });
    const p = new CoverageProcessor({ reportPath: join(root, "jacoco.xml"), srcFilePath: join(root, "src/Calc.java"), coverageType: "jacoco" });
    expect(p.parseCoverageReport()).toEqual({ linesCovered: [3, 5], linesMissed: [4], percentageCovered: 2 / 3 });
  });

  it("parses CSV for a Kotlin class", () => {
    const root = makeTmpDir();
    writeFiles(root, {
      "src/Calc.kt": "package com.example\n\ndata class Calc(val x: Int)\n",
      "jacoco.csv": "GROUP,PACKAGE,CLASS,LINE_MISSED,LINE_COVERED\napp,com.example,Calc,1,3\n",
    });
    const p = new CoverageProcessor({ reportPath: join(root, "jacoco.csv"), srcFilePath: join(root, "src/Calc.kt"), coverageType: "jacoco" });
    expect(p.parseCoverageReport().percentageCovered).toBe(0.75);
  });

  it("extracts package/class for records and generics", () => {
    const root = makeTmpDir();
    writeFiles(root, { "R.java": "package a.b;\npublic record Point(int x, int y) {\n}\n", "G.java": "package g;\nclass Box<T> {\n}\n" });
    expect(new CoverageProcessor({ reportPath: "x", srcFilePath: join(root, "R.java"), coverageType: "jacoco" }).extractPackageAndClassJava()).toEqual(["a.b", "Point"]);
    expect(new CoverageProcessor({ reportPath: "x", srcFilePath: join(root, "G.java"), coverageType: "jacoco" }).extractPackageAndClassJava()).toEqual(["g", "Box"]);
  });
});

describe("report freshness", () => {
  it("throws when the report is missing", () => {
    const p = new CoverageProcessor({ reportPath: "/definitely/missing.xml", srcFilePath: "x", coverageType: "cobertura" });
    expect(() => p.verifyReportUpdate(Date.now())).toThrow(CoverageReportMissingError);
  });

  it("only warns when the report is stale", () => {
    const root = makeTmpDir();
    writeFiles(root, { "c.xml": "<coverage/>" });
    utimesSync(join(root, "c.xml"), new Date(0), new Date(0));
    const warnings: string[] = [];
    const p = new CoverageProcessor({
      reportPath: join(root, "c.xml"),
      srcFilePath: "x",
      coverageType: "cobertura",
      logger: { debug() {}, info() {}, error() {}, warn: (m) => warnings.push(m) },
    });
    p.verifyReportUpdate(Date.now());
    expect(warnings[0]).toMatch(/not updated/);
  });
});

describe("matchReportPath", () => {
  it("classifies exact, suffix and non-matches", () => {
    expect(matchReportPath("src/a.ts", "/repo/src/a.ts", ["/repo"])).toBe("exact");
    expect(matchReportPath("src/a.ts", "/repo/pkg/src/a.ts", ["/elsewhere"])).toBe("suffix");
    expect(matchReportPath("a.ts", "/repo/src/ba.ts", [])).toBe(false);
    expect(matchReportPath("/repo/src/a.ts", "/repo/src/a.ts", [])).toBe("exact");
  });
});
