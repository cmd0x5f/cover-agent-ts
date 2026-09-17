import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AICallerReplay } from "../src/ai/aiCallerReplay.js";
import { RecordReplayManager } from "../src/ai/recordReplayManager.js";
import { safeLoad } from "../src/utils/loadYaml.js";
import { makeTmpDir, writeFiles } from "./helpers/tmp.js";

const FIX = join(import.meta.dirname, "fixtures", "upstream-typescript-calculator");
const devNull = { write: () => true } as unknown as NodeJS.WritableStream;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(() => {
  delete process.env["TEST_NAME"];
});

describe("RecordReplayManager", () => {
  it("finds and replays a recording written by the Python tool", async () => {
    const dir = makeTmpDir();
    copyFileSync(join(FIX, "typescript_calculator_responses_59a42f4afe25.yml"), join(dir, "typescript_calculator_responses_59a42f4afe25.yml"));
    process.env["TEST_NAME"] = "typescript_calculator";
    const manager = new RecordReplayManager(false, dir, silent);
    const src = join(FIX, "Calculator.ts");
    const test = join(FIX, "Calculator.test.ts");
    expect(manager.hasResponseFile(src, test)).toBe(true);

    const replay = new AICallerReplay(src, test, { recordReplayManager: manager, logger: silent, out: devNull });
    // Fuzzy lookup: a generate_tests prompt whose tail differs (e.g. new coverage numbers) still
    // resolves, because matching uses the first 1000 characters with a 95 threshold.
    const recorded = (safeLoad(readFileSync(join(FIX, "typescript_calculator_responses_59a42f4afe25.yml"), "utf8")) as any)
      .generate_tests["894f1e2b37de"].prompt.user as string;
    const response = await replay.callModel(
      { system: "", user: recorded.replace("Percentage covered:", "Percentage covered (changed):") },
      "generate_tests",
    );
    expect(response.content).toContain("evaluates basic addition");
    expect(response.promptTokens).toBe(3295);
  });

  it("round-trips a recording and uses the direct hash on exact prompts", () => {
    const dir = makeTmpDir();
    writeFiles(dir, { "pkg/a.ts": "export const a = 1;\n", "pkg/a.test.ts": "test\n" });
    const src = join(dir, "pkg/a.ts");
    const test = join(dir, "pkg/a.test.ts");
    const prompt = { system: "sys 'quoted'", user: "user\nprompt ✓" };

    new RecordReplayManager(true, join(dir, "responses"), silent).recordResponse(
      src, test, prompt, { content: "yaml: here", promptTokens: 12, completionTokens: 3 }, "analyze_test_insert_line",
    );
    const replayer = new RecordReplayManager(false, join(dir, "responses"), silent);
    expect(replayer.getResponseFilePath(src, test)).toMatch(/pkg_responses_[0-9a-f]{12}\.yml$/);
    expect(replayer.loadRecordedResponse(src, test, prompt, "analyze_test_insert_line", false)).toEqual({
      content: "yaml: here", promptTokens: 12, completionTokens: 3,
    });
    expect(replayer.loadRecordedResponse(src, test, prompt, "generate_tests")).toBeUndefined();
  });

  it("replay throws when nothing matches", async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { "x/a.ts": "1", "x/b.ts": "2" });
    const replay = new AICallerReplay(join(dir, "x/a.ts"), join(dir, "x/b.ts"), {
      recordReplayManager: new RecordReplayManager(false, dir, silent), logger: silent, out: devNull,
    });
    await expect(replay.callModel({ system: "", user: "hi" }, "generate_tests")).rejects.toThrow(/No recorded response/);
  });
});
