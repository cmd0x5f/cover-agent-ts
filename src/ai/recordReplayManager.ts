/**
 * Port of cover_agent/record_replay_manager.py
 *
 * Recording files are format-compatible with the Python tool in both directions:
 * the same file naming ("<test_name>_responses_<files_hash>.yml"), the same
 * caller -> prompt_hash -> entry layout, and the same prompt hash
 * (sha256 of Python's repr() of the {"system", "user"} dict, truncated).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { dump } from "js-yaml";
import { getSettings } from "../config/settings.js";
import { getLogger, type Logger } from "../logger.js";
import { safeLoad } from "../utils/loadYaml.js";
import { pyDictRepr, tokenSortRatio } from "../utils/pyCompat.js";
import type { ModelResponse, Prompt } from "./types.js";

interface RecordedEntry {
  prompt: Prompt;
  response: string;
  prompt_tokens: number;
  completion_tokens: number;
}

type RecordFile = { metadata?: { files_hash: string } } & Record<
  string,
  Record<string, RecordedEntry> | { files_hash: string }
>;

export function truncateHash(hash: string, length: number): string {
  return hash.slice(0, length);
}

export function promptHash(prompt: Prompt, length: number): string {
  // Key order matters for repr(): Python prompts are always built as {"system", "user"}.
  const repr = pyDictRepr({ system: prompt.system, user: prompt.user });
  return truncateHash(createHash("sha256").update(repr, "utf8").digest("hex"), length);
}

export class RecordReplayManager {
  readonly hashDisplayLength: number;
  private filesHash: string | undefined;
  private readonly logger: Logger;
  private readonly settings = getSettings().default;

  constructor(
    readonly recordMode: boolean,
    readonly baseDir: string = getSettings().default.responses_folder,
    logger?: Logger,
  ) {
    this.hashDisplayLength = this.settings.record_replay_hash_display_length;
    this.logger = logger ?? getLogger("record_replay_manager");
    this.logger.info(
      `✨ RecordReplayManager initialized in ${recordMode ? "Run and Record" : "Run or Replay"} mode.`,
    );
  }

  hasResponseFile(sourceFile: string, testFile: string): boolean {
    if (!sourceFile || !testFile) {
      throw new Error("Source file and test file paths must be set to check response file existence");
    }
    const file = this.getResponseFilePath(sourceFile, testFile);
    const exists = existsSync(file);
    this.logger.debug(`${exists ? "Found" : "Did not find"} recorded LLM response file: ${file}`);
    return exists;
  }

  loadRecordedResponse(
    sourceFile: string,
    testFile: string,
    prompt: Prompt,
    callerName = "unknown_caller",
    fuzzyLookup = true,
  ): ModelResponse | undefined {
    if (this.recordMode) {
      this.logger.debug("Skipping record loading in record mode.");
      return undefined;
    }
    const file = this.getResponseFilePath(sourceFile, testFile);
    if (!existsSync(file)) {
      this.logger.debug(`Recorded LLM response file not found: ${file}.`);
      return undefined;
    }

    try {
      const data = safeLoad(readFileSync(file, "utf8")) as RecordFile | null;
      const callerRecords = data?.[callerName] as Record<string, RecordedEntry> | undefined;
      if (!callerRecords) {
        this.logger.info(`No records found for caller ${callerName}.`);
        return undefined;
      }

      const hash = promptHash(prompt, this.hashDisplayLength);
      this.logger.info(`Do a direct hash lookup for prompt hash ${hash} under caller ${callerName}()...`);
      const direct = callerRecords[hash];
      if (direct) {
        this.logger.info(`Record hit for caller ${callerName}() with prompt hash ${hash}.`);
        return toResponse(direct);
      }
      this.logger.info(`No record entry found for prompt hash ${hash} under caller ${callerName}().`);

      if (fuzzyLookup) {
        const prompts = Object.fromEntries(
          Object.entries(callerRecords).map(([k, v]) => [k, v.prompt.user]),
        );
        const fuzzyHash = this.findClosestPromptMatch(prompt.user, prompts);
        if (fuzzyHash) {
          this.logger.info(`Found fuzzy match for prompt hash ${fuzzyHash} under caller ${callerName}().`);
          return toResponse(callerRecords[fuzzyHash]!);
        }
        this.logger.warn(`No record entry found under caller ${callerName}() after fuzzy lookup.`);
      }
    } catch (e) {
      this.logger.error(`Error loading recorded LLM response ${String(e)}`);
    }
    return undefined;
  }

  recordResponse(
    sourceFile: string,
    testFile: string,
    prompt: Prompt,
    result: ModelResponse,
    callerName = "unknown_caller",
  ): void {
    if (!this.recordMode) {
      this.logger.info("Skipping LLM response record in replay mode.");
      return;
    }
    const file = this.getResponseFilePath(sourceFile, testFile);
    this.logger.info(`Recording LLM response to ${file}...`);

    const filesHash = truncateHash(this.calculateFilesHash(sourceFile, testFile), this.hashDisplayLength);
    const cached: Record<string, unknown> = { metadata: { files_hash: filesHash } };

    if (existsSync(file)) {
      try {
        const loaded = safeLoad(readFileSync(file, "utf8"));
        if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
          for (const [k, v] of Object.entries(loaded)) if (k !== "metadata") cached[k] = v;
        }
      } catch {
        this.logger.warn(`Invalid YAML in ${file}, starting fresh.`);
      }
    }

    const hash = promptHash(prompt, this.hashDisplayLength);
    this.logger.info(`🔴 Recording new LLM response for ${callerName}() (prompt hash ${hash})...`);
    const callerRecords = (cached[callerName] as Record<string, RecordedEntry> | undefined) ?? {};
    callerRecords[hash] = {
      prompt: { system: prompt.system, user: prompt.user },
      response: result.content,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
    };
    cached[callerName] = callerRecords;

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, dump(cached, { lineWidth: -1, noRefs: true }));
    this.logger.info("Record file updated successfully.");
  }

  private calculateFilesHash(sourceFile: string, testFile: string): string {
    if (this.filesHash) return this.filesHash;
    const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
    const sourceHash = sha(readFileSync(sourceFile));
    const testHash = sha(readFileSync(testFile));
    this.filesHash = sha(sourceHash + testHash);
    this.logger.info(`Generated new files hash ${truncateHash(this.filesHash, this.hashDisplayLength)}.`);
    return this.filesHash;
  }

  getResponseFilePath(sourceFile: string, testFile: string): string {
    const filesHash = truncateHash(this.calculateFilesHash(sourceFile, testFile), this.hashDisplayLength);
    let testName = process.env["TEST_NAME"] ?? "default";
    if (testName === "default") {
      // Python: Path(source_file).parts[-2]
      const parts = resolveParts(sourceFile);
      if (parts.length >= 2) testName = parts[parts.length - 2]!;
    }
    return resolve(join(this.baseDir, `${testName}_responses_${filesHash}.yml`));
  }

  private findClosestPromptMatch(
    currentPrompt: string,
    recordedPrompts: Record<string, string>,
    threshold = this.settings.fuzzy_lookup_threshold,
    prefixLength: number | undefined = this.settings.fuzzy_lookup_prefix_length,
    bestRatioStart = this.settings.fuzzy_lookup_best_ratio,
  ): string | undefined {
    this.logger.info(
      `Starting fuzzy prompt matching with ${Object.keys(recordedPrompts).length} recorded prompts (threshold ${threshold})...`,
    );
    const prefix = (s: string) => (prefixLength && s.length > prefixLength ? s.slice(0, prefixLength) : s);
    const currentText = prefix(currentPrompt);

    let bestRatio = bestRatioStart;
    let bestMatch: string | undefined;
    for (const [hash, text] of Object.entries(recordedPrompts)) {
      const ratio = tokenSortRatio(currentText, prefix(text));
      this.logger.info(`Comparing with ${hash}: similarity ratio=${ratio}...`);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestMatch = hash;
      }
    }
    const result = bestRatio >= threshold ? bestMatch : undefined;
    this.logger.info(`Final result: best_ratio=${bestRatio}, match=${result ? "found" : "not found"}`);
    return result;
  }
}

function toResponse(entry: RecordedEntry): ModelResponse {
  return {
    content: entry.response,
    promptTokens: Number(entry.prompt_tokens),
    completionTokens: Number(entry.completion_tokens),
  };
}

function resolveParts(p: string): string[] {
  // pathlib.Path(p).parts on a relative path keeps it relative; we only need the parent name.
  const normalized = p.split(sep).join("/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return [basename(p)];
  return parts;
}
