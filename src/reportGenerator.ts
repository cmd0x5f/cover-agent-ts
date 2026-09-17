/**
 * Port of cover_agent/report_generator.py
 *
 * Differences:
 * - All user content is HTML-escaped. Upstream rendered stderr/stdout/test code raw, so JSX
 *   in a generated React test (e.g. `<Button />`) was interpreted as markup and broke the page.
 * - Status cell colours work (upstream emitted class "status-PASS" but styled ".status-pass").
 * - difflib.ndiff is replaced by a small LCS line diff; "?" hint lines are not emitted.
 */
import { writeFileSync } from "node:fs";

export interface ReportRow {
  id?: number;
  status: string;
  reason: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  testCode: string;
  imports: string;
  language: string;
  prompt?: string;
  sourceFile?: string;
  originalTestFile: string;
  processedTestFile: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type DiffOp = { op: " " | "+" | "-"; line: string };

/** Line diff via longest common subsequence. Test files are small, O(n*m) is fine. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", line: a[i++]! });
    } else {
      out.push({ op: "+", line: b[j++]! });
    }
  }
  while (i < n) out.push({ op: "-", line: a[i++]! });
  while (j < m) out.push({ op: "+", line: b[j++]! });
  return out;
}

export class ReportGenerator {
  static generateFullDiff(original: string, processed: string): string {
    const cls = { "+": "diff-added", "-": "diff-removed", " ": "diff-unchanged" } as const;
    return diffLines(original.split(/\r?\n/), processed.split(/\r?\n/))
      .map(({ op, line }) => `<span class="${cls[op]}">${escapeHtml(`${op} ${line}`)}</span>`)
      .join("\n");
  }

  static renderReport(results: ReportRow[]): string {
    const rows = results
      .map((r) => {
        const lang = escapeHtml(r.language.toLowerCase());
        const status = escapeHtml(r.status);
        return `
      <tr>
        <td class="status-${status.toLowerCase()}">${status}</td>
        <td>${escapeHtml(r.reason)}</td>
        <td>${r.exitCode ?? ""}</td>
        <td>${escapeHtml(r.language)}</td>
        <td>
          <details>
            <summary>View Full Code</summary>
            <pre><code>${ReportGenerator.generateFullDiff(r.originalTestFile, r.processedTestFile)}</code></pre>
          </details>
        </td>
        <td>
          <details>
            <summary>View More</summary>
            <div><strong>STDERR:</strong> <pre><code class="language-${lang}">${escapeHtml(r.stderr)}</code></pre></div>
            <div><strong>STDOUT:</strong> <pre><code class="language-${lang}">${escapeHtml(r.stdout)}</code></pre></div>
            <div><strong>Test Code:</strong> <pre><code class="language-${lang}">${escapeHtml(r.testCode)}</code></pre></div>
            <div><strong>Imports:</strong> <pre><code class="language-${lang}">${escapeHtml(r.imports)}</code></pre></div>
          </details>
        </td>
      </tr>`;
      })
      .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Results</title>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.23.0/themes/prism-okaidia.min.css" rel="stylesheet" />
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 20px; }
    table { border-collapse: collapse; width: 100%; box-shadow: 0 2px 3px rgba(0,0,0,0.1); }
    th, td { border: 1px solid #ddd; text-align: left; padding: 8px; vertical-align: top; }
    th { background-color: #f2f2f2; }
    tr:nth-child(even) { background-color: #f9f9f9; }
    .status-pass { color: green; font-weight: 600; }
    .status-fail { color: red; font-weight: 600; }
    pre { background-color: #282c34 !important; color: #ffffff !important; padding: 10px; border-radius: 5px;
          overflow-x: auto; white-space: pre-wrap; font-family: 'Courier New', Courier, monospace; font-size: 1.1em; }
    .diff-added { color: #98c379; }
    .diff-removed { color: #e06c75; }
  </style>
</head>
<body>
  <table>
    <tr>
      <th>Status</th><th>Reason</th><th>Exit Code</th><th>Language</th><th>Modified Test File</th><th>Details</th>
    </tr>${rows}
  </table>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.23.0/prism.min.js"></script>
</body>
</html>
`;
  }

  static generateReport(results: ReportRow[], filePath: string): void {
    writeFileSync(filePath, ReportGenerator.renderReport(results));
  }
}
