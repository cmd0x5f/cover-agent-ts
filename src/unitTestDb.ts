/**
 * Port of cover_agent/unit_test_db.py
 *
 * SQLAlchemy is replaced by Node's built-in `node:sqlite` (no native addon to compile in CI).
 * The table name and columns are identical to the Python tool, so existing tooling that
 * reads `cover_agent_unit_test_runs.db` keeps working, and the file doubles as an audit trail
 * of every generated test, its prompt, and why it was kept or rejected.
 */
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { ReportGenerator, type ReportRow } from "./reportGenerator.js";
import type { TestAttemptResult } from "./unitTestValidator.js";

const require = createRequire(import.meta.url);

function openDatabase(path: string): DatabaseSyncType {
  // Loaded lazily so runs with --suppress-log-files never touch the experimental module.
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS unit_test_generation_attempts (
  id INTEGER NOT NULL PRIMARY KEY,
  run_time DATETIME,
  status VARCHAR,
  reason TEXT,
  exit_code INTEGER,
  stderr TEXT,
  stdout TEXT,
  test_code TEXT,
  imports TEXT,
  language VARCHAR,
  prompt TEXT,
  source_file TEXT,
  original_test_file TEXT,
  processed_test_file TEXT
)`;

/** SQLAlchemy's SQLite DateTime storage format: "YYYY-MM-DD HH:MM:SS.ffffff" (local time). */
function sqlalchemyDateTime(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`
  );
}

export class UnitTestDB {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec(SCHEMA);
  }

  insertAttempt(result: TestAttemptResult): number {
    const stmt = this.db.prepare(`
      INSERT INTO unit_test_generation_attempts
        (run_time, status, reason, exit_code, stderr, stdout, test_code, imports, language,
         prompt, source_file, original_test_file, processed_test_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(
      sqlalchemyDateTime(),
      result.status,
      result.reason,
      result.exitCode,
      result.stderr,
      result.stdout,
      String(result.test.test_code ?? ""),
      String(result.test.new_imports_code ?? ""),
      result.language,
      result.prompt ?? null,
      result.sourceFile,
      result.originalTestFile,
      result.processedTestFile,
    );
    return Number(info.lastInsertRowid);
  }

  getAllAttempts(): ReportRow[] {
    const rows = this.db
      .prepare("SELECT * FROM unit_test_generation_attempts ORDER BY id")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      status: String(r["status"] ?? ""),
      reason: String(r["reason"] ?? ""),
      exitCode: r["exit_code"] == null ? null : Number(r["exit_code"]),
      stderr: String(r["stderr"] ?? ""),
      stdout: String(r["stdout"] ?? ""),
      testCode: String(r["test_code"] ?? ""),
      imports: String(r["imports"] ?? ""),
      language: String(r["language"] ?? ""),
      prompt: String(r["prompt"] ?? ""),
      sourceFile: String(r["source_file"] ?? ""),
      originalTestFile: String(r["original_test_file"] ?? ""),
      processedTestFile: String(r["processed_test_file"] ?? ""),
    }));
  }

  dumpToReport(reportFilepath: string): void {
    ReportGenerator.generateReport(this.getAllAttempts(), reportFilepath);
  }

  close(): void {
    this.db.close();
  }
}
