/**
 * Port of cover_agent/coverage_processor.py
 *
 * Differences from Python (see MIGRATION.md "Intentional behaviour changes"):
 * - Path-aware matching (item 1). Upstream matched a report entry with
 *   `filename.endswith(basename(src_file_path))`, so in a monorepo every `index.ts` in the
 *   report was merged into one file's coverage and `Calculator.ts` also matched
 *   `MyCalculator.ts`. Report paths are now resolved against the Cobertura `<source>` roots,
 *   the report's own directory and cwd; a segment-aware suffix match is the fallback, and an
 *   exact match anywhere in the report always beats a suffix match.
 * - `parseAllFiles()` works for LCOV (item 4). Upstream's LCOV branch returned a tuple where
 *   the `--use-report-coverage-feature-flag` caller expected a per-file dict, and crashed.
 * - Line numbers come back sorted ascending (item 5). Upstream returned `list(set(...))`.
 * - A stale report only warns; a *missing* report throws. Upstream used a bare `assert` for the
 *   missing case, which vanishes under `python -O`.
 * - Parse failures raise `UnsupportedCoverageReportError` rather than surfacing the underlying
 *   XML/CSV error, so `UnitTestValidator` can fall back to feeding the raw report to the model.
 *
 * The JaCoCo logic is ported as-is, quirks included: the Java/Kotlin package+class regexes, the
 * `mi == "0"` means covered rule, and the CSV branch that returns only a percentage with empty
 * line arrays (JaCoCo CSV reports totals, not line numbers).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { CoverageType } from "../config/schema.js";
import { getLogger, type Logger } from "../logger.js";

/** Covered/missed line numbers (sorted ascending) and the covered fraction in [0, 1]. */
export interface FileCoverage {
  linesCovered: number[];
  linesMissed: number[];
  percentageCovered: number;
}

/** The test command did not produce the coverage report at all. */
export class CoverageReportMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageReportMissingError";
  }
}

/** The report exists but cannot be understood: unknown type, unknown format, or malformed. */
export class UnsupportedCoverageReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCoverageReportError";
  }
}

export interface CoverageProcessorOptions {
  /** Path to the coverage report produced by the test command. */
  reportPath: string;
  /** Fully qualified path of the source file coverage is wanted for. */
  srcFilePath: string;
  coverageType: CoverageType;
  logger?: Logger;
}

const EMPTY_COVERAGE: FileCoverage = { linesCovered: [], linesMissed: [], percentageCovered: 0 };

/** Mutable accumulator for one file, before de-duplication and sorting. */
interface LineAccumulator {
  covered: Set<number>;
  missed: Set<number>;
}

type XmlNode = Record<string, unknown>;

function isRecord(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** fast-xml-parser collapses a single repeated child into an object; normalise to an array. */
function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Direct children named `tag`, the equivalent of ElementTree's `findall("tag")`. */
function children(node: XmlNode, tag: string): XmlNode[] {
  return toArray(node[tag]).filter(isRecord);
}

/** Every descendant named `tag`, the equivalent of ElementTree's `findall(".//tag")`. */
function descendants(node: unknown, tag: string): XmlNode[] {
  const found: XmlNode[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, value] of Object.entries(current)) {
      if (key.startsWith("@_") || key === "#text") continue;
      if (key === tag) found.push(...toArray(value).filter(isRecord));
      visit(value);
    }
  };
  visit(node);
  return found;
}

function attr(node: XmlNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  return value === undefined || value === null ? undefined : String(value);
}

/** Split a path into non-empty segments, tolerating Windows separators and `.` components. */
function segments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
}

function isAbsolutePosixOrWin(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Classify how a path taken from a coverage report relates to an absolute source file path.
 *
 * `"exact"` when the report path, resolved against any of `roots` (or taken as-is when it is
 * already absolute), *is* the source file. `"suffix"` when the report path's segments are a
 * suffix of the source file's segments — segment-aware, so `a.ts` does not match `.../ba.ts`.
 */
export function matchReportPath(
  reportPath: string,
  srcFilePath: string,
  roots: string[],
): "exact" | "suffix" | false {
  if (!reportPath) return false;
  const src = resolve(srcFilePath);

  if (isAbsolutePosixOrWin(reportPath) && resolve(reportPath) === src) return "exact";
  for (const root of roots) {
    if (resolve(root, reportPath) === src) return "exact";
  }

  const reportSegments = segments(reportPath);
  const srcSegments = segments(src);
  if (reportSegments.length === 0 || reportSegments.length > srcSegments.length) return false;
  const tail = srcSegments.slice(srcSegments.length - reportSegments.length);
  return tail.every((part, i) => part === reportSegments[i]) ? "suffix" : false;
}

function emptyAccumulator(): LineAccumulator {
  return { covered: new Set<number>(), missed: new Set<number>() };
}

function record(acc: LineAccumulator, lineNumber: number, hits: number): void {
  if (hits > 0) acc.covered.add(lineNumber);
  else acc.missed.add(lineNumber);
}

/** Deduplicate (covered wins over missed), sort ascending, and compute the percentage. */
function finalize(acc: LineAccumulator | undefined): FileCoverage {
  if (!acc) return { ...EMPTY_COVERAGE };
  const linesCovered = [...acc.covered].sort((a, b) => a - b);
  const linesMissed = [...acc.missed].filter((line) => !acc.covered.has(line)).sort((a, b) => a - b);
  const total = linesCovered.length + linesMissed.length;
  return {
    linesCovered,
    linesMissed,
    percentageCovered: total > 0 ? linesCovered.length / total : 0,
  };
}

function toMap(files: Map<string, LineAccumulator>): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  for (const [name, acc] of files) out.set(name, finalize(acc));
  return out;
}

/** A per-file view of a coverage report, keyed by the report's own (unresolved) path strings. */
interface ParsedReport {
  files: Map<string, LineAccumulator>;
  /** Directories that relative report paths may be relative to, most specific first. */
  roots: string[];
}

export class CoverageProcessor {
  private readonly reportPath: string;
  private readonly srcFilePath: string;
  private readonly coverageType: CoverageType;
  private readonly logger: Logger;

  /** Nothing is read here: both paths may still be produced by the test command. */
  constructor(options: CoverageProcessorOptions) {
    this.reportPath = options.reportPath;
    this.srcFilePath = options.srcFilePath;
    this.coverageType = options.coverageType;
    this.logger = options.logger ?? getLogger("coverage_processor");
  }

  /** Verify the report is there, then parse out the source file's coverage. */
  processCoverageReport(timeOfTestCommand: number): FileCoverage {
    this.verifyReportUpdate(timeOfTestCommand);
    return this.parseCoverageReport();
  }

  /** Verify the report is there, then parse out every file it mentions. */
  processCoverageReportAllFiles(timeOfTestCommand: number): Map<string, FileCoverage> {
    this.verifyReportUpdate(timeOfTestCommand);
    return this.parseAllFiles();
  }

  /**
   * Throw if the report is missing; only warn if it is stale. Staleness is common and benign
   * (a test runner that skips writing an unchanged report), so it must not abort the run.
   */
  verifyReportUpdate(timeOfTestCommand: number): void {
    if (!existsSync(this.reportPath)) {
      throw new CoverageReportMissingError(
        `Fatal: Coverage report "${this.reportPath}" was not generated.`,
      );
    }
    const fileModTimeMs = Math.round(statSync(this.reportPath).mtimeMs);
    if (!(fileModTimeMs > timeOfTestCommand)) {
      this.logger.warn(
        `The coverage report file was not updated after the test command. ` +
          `file_mod_time_ms: ${fileModTimeMs}, time_of_test_command: ${timeOfTestCommand}.`,
      );
    }
  }

  /** Coverage for `srcFilePath`. A file absent from the report reports 0%. */
  parseCoverageReport(): FileCoverage {
    switch (this.coverageType) {
      case "cobertura":
      case "lcov": {
        const { files, roots } = this.parseReport();
        return finalize(this.selectFile(files, roots));
      }
      case "jacoco":
        return this.parseJacoco();
      default:
        throw new UnsupportedCoverageReportError(
          `Unsupported coverage report type: ${String(this.coverageType)}`,
        );
    }
  }

  /**
   * Coverage for every file in the report, keyed by the report's own path strings (the raw
   * Cobertura `filename` attribute / the raw LCOV `SF:` value), never a resolved path.
   */
  parseAllFiles(): Map<string, FileCoverage> {
    if (this.coverageType === "jacoco") {
      // JaCoCo reports per class, not per source path; the best we can do is the one file asked for.
      return new Map([[this.srcFilePath, this.parseJacoco()]]);
    }
    return toMap(this.parseReport().files);
  }

  private parseReport(): ParsedReport {
    switch (this.coverageType) {
      case "cobertura":
        return this.parseCobertura();
      case "lcov":
        return this.parseLcov();
      default:
        throw new UnsupportedCoverageReportError(
          `Unsupported coverage report type: ${String(this.coverageType)}`,
        );
    }
  }

  /** Exact matches anywhere in the report beat a suffix match, so scan the whole report first. */
  private selectFile(
    files: Map<string, LineAccumulator>,
    roots: string[],
  ): LineAccumulator | undefined {
    let suffixMatch: LineAccumulator | undefined;
    for (const [name, acc] of files) {
      const match = matchReportPath(name, this.srcFilePath, roots);
      if (match === "exact") return acc;
      if (match === "suffix" && suffixMatch === undefined) suffixMatch = acc;
    }
    return suffixMatch;
  }

  private readReport(): string {
    try {
      return readFileSync(this.reportPath, "utf8");
    } catch (e) {
      throw new UnsupportedCoverageReportError(
        `Error reading coverage report "${this.reportPath}": ${String(e)}`,
      );
    }
  }

  private parseXml(): XmlNode {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    let parsed: unknown;
    try {
      parsed = parser.parse(this.readReport());
    } catch (e) {
      throw new UnsupportedCoverageReportError(
        `Error parsing coverage report "${this.reportPath}": ${String(e)}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new UnsupportedCoverageReportError(
        `Error parsing coverage report "${this.reportPath}": no XML document found.`,
      );
    }
    return parsed;
  }

  // ---------------------------------------------------------------- Cobertura

  private parseCobertura(): ParsedReport {
    const root = this.parseXml();
    const files = new Map<string, LineAccumulator>();

    // Multiple <class> entries may share a filename (one per class in the file); merge them.
    for (const cls of descendants(root, "class")) {
      const filename = attr(cls, "filename");
      if (!filename) continue;
      let acc = files.get(filename);
      if (!acc) {
        acc = emptyAccumulator();
        files.set(filename, acc);
      }
      for (const line of descendants(cls, "line")) {
        const number = Number(attr(line, "number"));
        const hits = Number(attr(line, "hits"));
        if (!Number.isFinite(number)) continue;
        record(acc, number, Number.isFinite(hits) ? hits : 0);
      }
    }

    return { files, roots: this.coberturaRoots(root) };
  }

  /** `<sources><source>…</source></sources>` first, then the report's directory, then cwd. */
  private coberturaRoots(root: XmlNode): string[] {
    const reportDir = dirname(resolve(this.reportPath));
    const roots: string[] = [];
    for (const sources of descendants(root, "sources")) {
      for (const source of toArray(sources["source"])) {
        const text = typeof source === "string" || typeof source === "number" ? String(source).trim() : "";
        if (text) roots.push(resolve(reportDir, text));
      }
    }
    roots.push(reportDir, process.cwd());
    return [...new Set(roots)];
  }

  // --------------------------------------------------------------------- LCOV

  private parseLcov(): ParsedReport {
    const files = new Map<string, LineAccumulator>();
    let current: LineAccumulator | undefined;

    for (const raw of this.readReport().split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("SF:")) {
        const name = line.slice(3).trim();
        if (!name) continue;
        current = files.get(name);
        if (!current) {
          current = emptyAccumulator();
          files.set(name, current);
        }
      } else if (line.startsWith("DA:") && current) {
        const [number, hits] = line.slice(3).split(",");
        const lineNumber = Number(number);
        if (!Number.isFinite(lineNumber)) continue;
        const hitCount = Number(hits);
        record(current, lineNumber, Number.isFinite(hitCount) ? hitCount : 0);
      } else if (line.startsWith("end_of_record")) {
        current = undefined;
      }
    }

    return { files, roots: [dirname(resolve(this.reportPath)), process.cwd()] };
  }

  // ------------------------------------------------------------------- JaCoCo

  /**
   * Ported from upstream verbatim. The CSV branch returns empty line arrays on purpose: JaCoCo's
   * CSV export gives totals rather than line numbers, and upstream chose to keep the tuple shape
   * rather than introduce a per-format result type.
   */
  private parseJacoco(): FileCoverage {
    const sourceExtension = extension(this.srcFilePath);

    let packageName = "";
    let className = "";
    if (sourceExtension === "java") {
      [packageName, className] = this.extractPackageAndClassJava();
    } else if (sourceExtension === "kt") {
      [packageName, className] = this.extractPackageAndClassKotlin();
    } else {
      this.logger.warn(`Unsupported Bytecode Language: ${sourceExtension}. Using default Java logic.`);
      [packageName, className] = this.extractPackageAndClassJava();
    }

    const reportExtension = extension(this.reportPath);
    let linesCovered: number[] = [];
    let linesMissed: number[] = [];
    let covered = 0;
    let missed = 0;

    if (reportExtension === "xml") {
      ({ linesCovered, linesMissed } = this.parseJacocoXml(className));
      covered = linesCovered.length;
      missed = linesMissed.length;
    } else if (reportExtension === "csv") {
      ({ covered, missed } = this.parseJacocoCsv(packageName, className));
    } else {
      throw new UnsupportedCoverageReportError(
        `Unsupported JaCoCo code coverage report format: ${reportExtension}`,
      );
    }

    const total = missed + covered;
    return {
      linesCovered: linesCovered.sort((a, b) => a - b),
      linesMissed: linesMissed.sort((a, b) => a - b),
      percentageCovered: total > 0 ? covered / total : 0,
    };
  }

  private parseJacocoXml(className: string): { linesCovered: number[]; linesMissed: number[] } {
    const root = this.parseXml();
    const sourcefiles = descendants(root, "sourcefile");
    const sourcefile =
      sourcefiles.find((node) => attr(node, "name") === `${className}.java`) ??
      sourcefiles.find((node) => attr(node, "name") === `${className}.kt`);
    if (!sourcefile) return { linesCovered: [], linesMissed: [] };

    const linesCovered: number[] = [];
    const linesMissed: number[] = [];
    for (const line of children(sourcefile, "line")) {
      const number = Number(attr(line, "nr") ?? 0);
      // JaCoCo counts *missed instructions*: none missed means the line is fully covered.
      if (attr(line, "mi") === "0") linesCovered.push(number);
      else linesMissed.push(number);
    }
    return { linesCovered, linesMissed };
  }

  private parseJacocoCsv(packageName: string, className: string): { covered: number; missed: number } {
    const rows = parseCsv(this.readReport());
    for (const row of rows) {
      if (row["PACKAGE"] === packageName && row["CLASS"] === className) {
        const missed = row["LINE_MISSED"];
        const covered = row["LINE_COVERED"];
        if (missed === undefined || covered === undefined) {
          const column = missed === undefined ? "LINE_MISSED" : "LINE_COVERED";
          this.logger.error(`Missing expected column in CSV: '${column}'`);
          throw new UnsupportedCoverageReportError(`Missing expected column in CSV: '${column}'`);
        }
        return { covered: Number(covered) || 0, missed: Number(missed) || 0 };
      }
    }
    return { covered: 0, missed: 0 };
  }

  /** `[packageName, className]` read from a `.java` source file. */
  extractPackageAndClassJava(): [string, string] {
    return this.extractPackageAndClass(
      /^\s*package\s+([\w.]+)\s*;.*$/,
      /^\s*(?:public\s+)?(?:class|interface|record)\s+(\w+)(?:(?:<|\().*?(?:>|\)))?(?:\s+extends|\s+implements|\s*\{|$)/,
    );
  }

  /** `[packageName, className]` read from a `.kt` source file. */
  extractPackageAndClassKotlin(): [string, string] {
    return this.extractPackageAndClass(
      /^\s*package\s+([\w.]+)\s*(?:;)?\s*(?:\/\/.*)?$/,
      /^\s*(?:public|internal|abstract|data|sealed|enum|open|final|private|protected)*\s*class\s+(\w+).*/,
    );
  }

  private extractPackageAndClass(packagePattern: RegExp, classPattern: RegExp): [string, string] {
    let source: string;
    try {
      source = readFileSync(this.srcFilePath, "utf8");
    } catch (e) {
      this.logger.error(`Error reading file ${this.srcFilePath}: ${String(e)}`);
      throw e;
    }

    let packageName = "";
    let className = "";
    for (const line of source.split(/\r?\n/)) {
      if (!packageName) {
        const match = packagePattern.exec(line);
        if (match?.[1]) packageName = match[1];
      }
      if (!className) {
        const match = classPattern.exec(line);
        if (match?.[1]) className = match[1];
      }
      if (packageName && className) break;
    }
    return [packageName, className];
  }
}

/** Lower-case extension without the dot, like Python's `os.path.splitext(...)[1].lstrip(".")`. */
function extension(path: string): string {
  return extname(path).replace(/^\./, "").toLowerCase();
}

/**
 * Minimal equivalent of Python's `csv.DictReader`: the first row names the columns, and quoted
 * fields (JaCoCo quotes class names containing commas) may contain separators and `""` escapes.
 */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((cells) => cells.length > 1 || (cells[0] ?? "") !== "")
    .map((cells) => {
      const record: Record<string, string> = {};
      header.forEach((name, i) => {
        record[name] = cells[i] ?? "";
      });
      return record;
    });
}
