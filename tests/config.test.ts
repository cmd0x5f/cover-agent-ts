import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";
import { getSettings } from "../src/config/settings.js";
import { getCodeLanguage } from "../src/utils/language.js";

const required = { sourceFilePath: "a.ts", testFilePath: "a.test.ts", codeCoverageReportPath: "c.xml", testCommand: "npm t" };

describe("config", () => {
  it("falls back to configuration.toml defaults", () => {
    const c = buildConfig(required);
    const d = getSettings().default;
    expect(c).toMatchObject({ desiredCoverage: d.desired_coverage, maxIterations: d.max_iterations, coverageType: "cobertura", includedFiles: [] });
  });

  it("rejects conflicting and unsupported options", () => {
    expect(() => buildConfig({ ...required, diffCoverage: true, useReportCoverageFeatureFlag: true })).toThrow(/not compatible/);
    expect(() => buildConfig({ ...required, coverageType: "clover" as never })).toThrow(/Unsupported coverage type/);
  });

  it("detects languages from the upstream extension map", () => {
    expect(getCodeLanguage("src/Button.tsx")).toBe("typescript");
    expect(getCodeLanguage("src/util.js")).toBe("javascript");
    expect(getCodeLanguage("README")).toBe("unknown");
  });
});
