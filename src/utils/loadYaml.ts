/**
 * Port of load_yaml() and try_fix_yaml() from cover_agent/utils.py.
 *
 * The fallback chain is kept step-for-step, including its quirks, because the prompts
 * were tuned against it. js-yaml's CORE schema is used (not YAML 1.1) — js-yaml's 1.1
 * schema treats bare `y`/`n` as booleans, which PyYAML's safe_load does not.
 */
import { load } from "js-yaml";
import { getLogger } from "../logger.js";

const logger = getLogger("utils");

/** PyYAML safe_load semantics: empty document -> null, duplicate keys -> last wins. */
export function safeLoad(text: string): unknown {
  if (text.trim() === "") return null;
  return load(text, { json: true });
}

export function loadYaml(responseText: string, keysFixYaml: string[] = []): unknown {
  let text = responseText.trim();
  if (text.startsWith("```yaml")) text = text.slice("```yaml".length);
  text = text.replace(/`+$/, "");
  try {
    return safeLoad(text);
  } catch (e) {
    logger.info(`Failed to parse AI prediction: ${String(e)}. Attempting to fix YAML formatting.`);
    const data = tryFixYaml(text, keysFixYaml);
    if (!data) logger.info("Failed to parse AI prediction after fixing YAML formatting.");
    return data;
  }
}

export function tryFixYaml(responseText: string, keysFixYaml: string[] = []): unknown {
  const lines = responseText.split("\n");

  // first fallback - try to convert 'relevant line: ...' to relevant line: |-\n        ...'
  const linesCopy = [...lines];
  for (let i = 0; i < linesCopy.length; i++) {
    for (const key of keysFixYaml) {
      const line = linesCopy[i]!;
      if (line.includes(key) && !line.includes("|-")) {
        linesCopy[i] = line.replaceAll(key, `${key} |-\n        `);
      }
    }
  }
  try {
    const data = safeLoad(linesCopy.join("\n"));
    logger.info("Successfully parsed AI prediction after adding |-\n");
    return data;
  } catch {
    /* next fallback */
  }

  // second fallback - try to extract only range from first ```yaml to ````
  const snippet = /```(yaml)?[\s\S]*?```/.exec(linesCopy.join("\n"));
  if (snippet) {
    let snippetText = snippet[0];
    if (snippetText.startsWith("```yaml")) snippetText = snippetText.slice("```yaml".length);
    snippetText = snippetText.replace(/`+$/, "");
    try {
      const data = safeLoad(snippetText);
      logger.info("Successfully parsed AI prediction after extracting yaml snippet");
      return data;
    } catch {
      /* next fallback */
    }
  }

  // third fallback - try to remove leading and trailing curly brackets
  let stripped = responseText.trim();
  if (stripped.startsWith("{")) stripped = stripped.slice(1);
  if (stripped.endsWith("}")) stripped = stripped.slice(0, -1);
  stripped = stripped.replace(/[:\n]+$/, "");
  try {
    const data = safeLoad(stripped);
    logger.info("Successfully parsed AI prediction after removing curly brackets");
    return data;
  } catch {
    /* next fallback */
  }

  // fourth fallback - try to remove last lines
  for (let i = 1; i < lines.length; i++) {
    try {
      const data = safeLoad(lines.slice(0, -i).join("\n"));
      if (pyContains(data, "language")) {
        logger.info(`Successfully parsed AI prediction after removing ${i} lines`);
        return data;
      }
    } catch {
      /* keep trimming */
    }
  }

  // fifth fallback - brute force: from 'language:' to the first blank line after the last 'test_code:'
  let indexStart = responseText.indexOf("\nlanguage:");
  if (indexStart === -1) indexStart = responseText.indexOf("language:");
  const indexLastCode = responseText.lastIndexOf("test_code:");
  let indexEnd = responseText.indexOf("\n\n", indexLastCode === -1 ? 0 : indexLastCode);
  if (indexEnd === -1) indexEnd = responseText.length;
  try {
    const data = safeLoad(sliceLikePython(responseText, indexStart, indexEnd).trim());
    logger.info("Successfully parsed AI prediction when using the language: key as a starting point");
    return data;
  } catch {
    return undefined;
  }
}

/** Python's `needle in value` for the value shapes YAML can produce. */
function pyContains(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.includes(needle);
  if (value && typeof value === "object") return needle in value;
  return false;
}

/** Python slicing treats -1 as "from the end", unlike String.prototype.slice for start. */
function sliceLikePython(s: string, start: number, end: number): string {
  const realStart = start < 0 ? Math.max(0, s.length + start) : start;
  return s.slice(realStart, end);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
