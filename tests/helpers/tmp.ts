import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

/** Temp dir removed after each test. Pass `base` to create it inside the repo (for node_modules resolution). */
export function makeTmpDir(base = tmpdir()): string {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "cover-agent-ts-"));
  created.push(dir);
  return dir;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});
