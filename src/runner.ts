/**
 * Port of cover_agent/runner.py
 *
 * Difference from Python: on timeout we kill the whole process group, not just the shell.
 * Python's subprocess.run(timeout=...) only kills the direct child, which leaves Vitest/Jest
 * worker processes running (and still writing coverage files) after a timeout.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Epoch milliseconds captured just before the command started. */
  commandStartTime: number;
}

export type RunCommand = (
  command: string,
  maxRunTimeSec: number,
  cwd?: string,
) => Promise<CommandResult>;

export const runCommand: RunCommand = (command, maxRunTimeSec, cwd) => {
  const commandStartTime = Date.now();
  const useProcessGroup = process.platform !== "win32";

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (useProcessGroup && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // process already gone
      }
    }, maxRunTimeSec * 1000);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: String(err), exitCode: -1, commandStartTime });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout: "", stderr: "Command timed out", exitCode: -1, commandStartTime });
        return;
      }
      // Mirror Python's negative return codes for signal-terminated processes.
      const exitCode =
        code ?? (signal ? -(constants.signals[signal] ?? 1) : -1);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        commandStartTime,
      });
    });
  });
};
