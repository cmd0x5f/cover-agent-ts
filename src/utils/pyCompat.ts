/**
 * Small helpers that reproduce Python behaviour where it leaks into persisted data.
 *
 * - pyRepr: the record/replay prompt hash is sha256(str(prompt_dict)) in Python, so
 *   reproducing repr() keeps recordings interchangeable between the Python tool and this port.
 * - formatPyFloat: Python prints round(50.0, 2) as "50.0"; JS prints "50".
 * - tokenSortRatio: fuzzywuzzy.fuzz.token_sort_ratio (Levenshtein-backed variant).
 */

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** repr() of a Python str. */
export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      if (cp <= 0xff) out += "\\x" + cp.toString(16).padStart(2, "0");
      else if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
      else out += "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return out + quote;
}

/** repr() of a flat Python dict[str, str], preserving insertion order. */
export function pyDictRepr(obj: Record<string, string>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${pyStrRepr(k)}: ${pyStrRepr(v)}`);
  return `{${parts.join(", ")}}`;
}

/** Equivalent of Python `str(round(x, 2))` for the percentages cover-agent logs and prompts with. */
export function formatPyFloat(value: number, digits = 2): string {
  const factor = 10 ** digits;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  const s = String(rounded);
  return Number.isInteger(rounded) && !s.includes("e") ? `${s}.0` : s;
}

function fullProcess(s: string): string {
  // force_ascii=True drops non-ASCII; then non-word chars -> spaces, lowercase, trim
  const ascii = [...s].filter((c) => c.codePointAt(0)! < 128).join("");
  return ascii.replace(/\W/g, " ").toLowerCase().trim();
}

function sortTokens(s: string): string {
  return fullProcess(s)
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Levenshtein.ratio(): (lensum - indel_distance) / lensum, i.e. 2*LCS / lensum. */
export function levenshteinRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        ai === b.charCodeAt(j - 1) ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return (2 * prev[b.length]!) / total;
}

export function tokenSortRatio(a: string, b: string): number {
  const sa = sortTokens(a);
  const sb = sortTokens(b);
  if (!sa || !sb) return 0;
  return Math.round(100 * levenshteinRatio(sa, sb));
}

/** json.dumps(obj) with Python defaults: ", " / ": " separators and ensure_ascii=True. */
export function pyJsonDumps(value: unknown): string {
  const asciiEscape = (s: string) =>
    JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const walk = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return asciiEscape(v);
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NaN";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (Array.isArray(v)) return `[${v.map(walk).join(", ")}]`;
    if (typeof v === "object") {
      return `{${Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${asciiEscape(k)}: ${walk(val)}`)
        .join(", ")}}`;
    }
    return asciiEscape(String(v));
  };
  return walk(value);
}
