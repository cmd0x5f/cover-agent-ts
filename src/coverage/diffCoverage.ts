/**
 * Replaces cover-agent's use of the Python `diff-cover` package.
 *
 * Upstream shelled out to `diff-cover --json-report ...` and parsed the JSON it wrote to a
 * temp file, which meant a Python runtime plus a pinned extra dependency just to intersect
 * two lists of line numbers. Here the same result is computed natively from `git diff -U0`.
 *
 * Deliberate differences from upstream:
 * - The changed-line set is the union of `<branch>...HEAD`, staged and unstaged diffs, so a
 *   test written against work-in-progress code is measured against that code. diff-cover was
 *   invoked with the branch comparison only.
 * - Changed lines that appear in neither the covered nor the missed list are not executable
 *   (blank lines, comments, imports the instrumenter skips) and are ignored entirely.
 * - A source file with no changed lines reports 100%, not 0% (MIGRATION.md item 6). Upstream
 *   reported 0% here and burned every iteration generating tests that could never count.
 */
import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { FileCoverage } from "./coverageProcessor.js";
import type { Logger } from "../logger.js";

/** Runs `git <args>` in `cwd` and resolves with stdout. Injectable so tests never touch git. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const FILE_HEADER = /^\+\+\+ (.*)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff -U0` output into repo-relative path -> set of NEW-file line numbers.
 *
 * The line numbers come from the hunk header ranges, not from counting `+` body lines: with
 * `-U0` the header range is exactly the set of added/modified lines, and it stays correct for
 * a hunk whose body is not present in the text being parsed. A hunk with a new-count of 0 is
 * a pure deletion and contributes nothing; a file deleted outright (`+++ /dev/null`) is
 * skipped entirely and never appears as a key.
 */
export function parseUnifiedDiff(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let currentFile: string | undefined;

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      currentFile = undefined;
      continue;
    }

    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      // `+++ b/path` (a trailing tab-separated timestamp is possible in non-git diffs).
      const target = (fileMatch[1] ?? "").split("\t")[0]?.trim() ?? "";
      currentFile = target === "/dev/null" || target === "" ? undefined : stripPrefix(target);
      continue;
    }

    if (currentFile === undefined) continue;

    const hunkMatch = HUNK_HEADER.exec(line);
    if (!hunkMatch) continue;

    const newStart = Number(hunkMatch[1]);
    const newCount = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
    if (!Number.isFinite(newStart) || !Number.isFinite(newCount) || newCount <= 0) continue;

    // Only create the entry once a hunk actually contributes, so no file ever maps to an empty set.
    let lines = changed.get(currentFile);
    if (!lines) {
      lines = new Set<number>();
      changed.set(currentFile, lines);
    }
    for (let n = newStart; n < newStart + newCount; n++) lines.add(n);
  }

  return changed;
}

function stripPrefix(path: string): string {
  return path.startsWith("b/") ? path.slice(2) : path;
}

const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolvePromise, rejectPromise) => {
    // No shell: argv is passed through verbatim, so paths with spaces are safe.
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

    child.on("error", (err) => {
      rejectPromise(new Error(`Failed to run \`git ${args.join(" ")}\`: ${String(err)}`));
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      rejectPromise(new Error(`\`git ${args.join(" ")}\` exited with code ${String(code)}: ${stderr}`));
    });
  });

/**
 * Collects every line touched relative to `comparisonBranch`, keyed by ABSOLUTE path.
 *
 * Diff paths are repo-relative, so they resolve against the root reported by `rev-parse`
 * rather than `cwd` — `cwd` is the test command directory, which is often a subdirectory.
 */
export async function getChangedLines(
  comparisonBranch: string,
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<Map<string, Set<number>>> {
  const repoRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();

  // Three-dot form: changes on HEAD since it diverged from the comparison branch.
  const branchDiff = await git(["diff", "-U0", `${comparisonBranch}...HEAD`], cwd);
  const stagedDiff = await git(["diff", "-U0", "--cached"], cwd);
  const unstagedDiff = await git(["diff", "-U0"], cwd);

  const merged = new Map<string, Set<number>>();
  for (const diff of [branchDiff, stagedDiff, unstagedDiff]) {
    for (const [relativePath, lines] of parseUnifiedDiff(diff)) {
      const absolute = resolve(repoRoot, relativePath);
      let target = merged.get(absolute);
      if (!target) {
        target = new Set<number>();
        merged.set(absolute, target);
      }
      for (const line of lines) target.add(line);
    }
  }

  return merged;
}

/**
 * Narrows a whole-file coverage report down to the lines the diff touched.
 */
export function computeDiffCoverage(
  sourceCoverage: FileCoverage,
  changedLines: Map<string, Set<number>>,
  srcFilePath: string,
  logger: Logger,
): FileCoverage {
  const absoluteSrc = resolve(srcFilePath);
  const changed = changedLines.get(absoluteSrc) ?? findBySuffix(changedLines, absoluteSrc);

  if (!changed || changed.size === 0) {
    logger.info(
      `Diff coverage: no changed lines in ${srcFilePath}; there is nothing to cover, reporting 100%.`,
    );
    return { linesCovered: [], linesMissed: [], percentageCovered: 1 };
  }

  const covered = new Set(sourceCoverage.linesCovered);
  const missed = new Set(sourceCoverage.linesMissed);

  const linesCovered: number[] = [];
  const linesMissed: number[] = [];
  for (const line of changed) {
    // A changed line in neither list is not executable; it must not count against coverage.
    if (covered.has(line)) linesCovered.push(line);
    else if (missed.has(line)) linesMissed.push(line);
  }
  linesCovered.sort((a, b) => a - b);
  linesMissed.sort((a, b) => a - b);

  const total = linesCovered.length + linesMissed.length;
  const percentageCovered = total === 0 ? 0 : linesCovered.length / total;
  logger.debug(
    `Diff coverage for ${srcFilePath}: ${linesCovered.length}/${total} changed executable lines covered.`,
  );

  return { linesCovered, linesMissed, percentageCovered };
}

/**
 * Segment-aware suffix match, used only when the exact path misses (a diff produced from a
 * different repo root, or a symlinked checkout). Comparing whole segments keeps `a.ts` from
 * matching `ba.ts`, the upstream `endswith` bug (MIGRATION.md item 1).
 */
function findBySuffix(
  changedLines: Map<string, Set<number>>,
  absoluteSrc: string,
): Set<number> | undefined {
  const srcSegments = absoluteSrc.split(sep).filter(Boolean);
  for (const [candidate, lines] of changedLines) {
    const candidateSegments = candidate.split(sep).filter(Boolean);
    if (isSuffix(srcSegments, candidateSegments) || isSuffix(candidateSegments, srcSegments)) {
      return lines;
    }
  }
  return undefined;
}

/** True when `suffix` matches the trailing segments of `segments`. */
function isSuffix(segments: string[], suffix: string[]): boolean {
  if (suffix.length === 0 || suffix.length > segments.length) return false;
  const offset = segments.length - suffix.length;
  for (let i = 0; i < suffix.length; i++) {
    if (segments[offset + i] !== suffix[i]) return false;
  }
  return true;
}
