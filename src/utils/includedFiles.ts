/**
 * Port of utils.get_included_files and settings/token_handling.clip_tokens.
 *
 * Token counting: Python used tiktoken's o200k_base encoder. Pulling a BPE table into a CLI
 * just to size a clipping budget is not worth the dependency, so we estimate ~4 characters
 * per token. Clipping is still character-based, exactly like upstream, just with an
 * estimated ratio instead of a measured one.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { getSettings } from "../config/settings.js";
import { getLogger } from "../logger.js";

const logger = getLogger("included_files");
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function clipTokens(
  text: string,
  maxTokens: number,
  numInputTokens = estimateTokens(text),
  addThreeDots = true,
): string {
  if (!text || numInputTokens <= maxTokens) return text;
  if (maxTokens <= 0) return "";
  const charsPerToken = text.length / numInputTokens;
  const numOutputChars = Math.floor(0.9 * charsPerToken * maxTokens);
  if (numOutputChars <= 0) return "";
  return text.slice(0, numOutputChars) + (addThreeDots ? "\n...(truncated)" : "");
}

export function getIncludedFiles(
  includedFiles: string[],
  projectRoot = "",
  disableTokens = false,
): string {
  if (!includedFiles.length) return "";

  const blocks: string[] = [];
  for (const filePath of includedFiles) {
    try {
      const content = readFileSync(filePath, "utf8");
      const rel = projectRoot ? relative(projectRoot, filePath) : filePath;
      blocks.push(`file_path: \`${rel}\`\ncontent:\n\`\`\`\n${content}\n\`\`\`\n\n\n`);
    } catch (e) {
      logger.error(`Error reading file ${filePath}: ${String(e)}`);
    }
  }

  let out = blocks.join("").trim();
  const { limit_tokens, max_tokens } = getSettings().include_files;
  if (!disableTokens && limit_tokens) {
    const numTokens = estimateTokens(out);
    if (numTokens > max_tokens) {
      logger.info(`Clipping included files content from ~${numTokens} to ${max_tokens} tokens`);
      out = clipTokens(out, max_tokens, numTokens);
    }
  }
  return out;
}
