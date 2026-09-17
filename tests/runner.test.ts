import { describe, expect, it } from "vitest";
import { runCommand } from "../src/runner.js";

describe("runCommand", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const r = await runCommand("echo out; echo err 1>&2; exit 3", 5);
    expect(r).toMatchObject({ stdout: "out\n", stderr: "err\n", exitCode: 3 });
    expect(r.commandStartTime).toBeLessThanOrEqual(Date.now());
  });

  it("runs in the given cwd", async () => {
    const r = await runCommand("pwd", 5, "/");
    expect(r.stdout.trim()).toBe("/");
  });

  it.skipIf(process.platform === "win32")("times out and kills child processes", async () => {
    const started = Date.now();
    const r = await runCommand("sleep 5 & sleep 5; wait", 0.3);
    expect(r).toMatchObject({ stdout: "", stderr: "Command timed out", exitCode: -1 });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
