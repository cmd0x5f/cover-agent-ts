/**
 * Port of cover_agent/settings/config_loader.py
 *
 * Python used Dynaconf to merge several TOML files into one settings object.
 * Here we parse the same TOML files (copied verbatim into /settings) with smol-toml
 * and merge their top-level tables. Keys never collide across files upstream, so a
 * shallow merge is equivalent.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export const SETTINGS_FILES = [
  "test_generation_prompt.toml",
  "language_extensions.toml",
  "analyze_suite_test_headers_indentation.toml",
  "analyze_suite_test_insert_line.toml",
  "analyze_test_run_failure.toml",
  "analyze_test_against_context.toml",
  "adapt_test_command_for_a_single_test_via_ai.toml",
  "configuration.toml",
] as const;

/** src/config/settings.ts and dist/config/settings.js are both two levels below the package root. */
export const SETTINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "settings");

export interface DefaultSettings {
  model: string;
  desired_coverage: number;
  max_iterations: number;
  api_base: string;
  max_run_time_sec: number;
  max_tests_per_run: number;
  allowed_initial_test_analysis_attempts: number;
  model_retries: number;
  run_tests_multiple_times: number;
  branch: string;
  coverage_type: string;
  log_file_path: string;
  log_db_path: string;
  report_filepath: string;
  responses_folder: string;
  record_replay_hash_display_length: number;
  fuzzy_lookup_threshold: number;
  fuzzy_lookup_prefix_length: number;
  fuzzy_lookup_best_ratio: number;
  [key: string]: unknown;
}

export interface PromptTemplate {
  system: string;
  user: string;
}

export interface Settings {
  default: DefaultSettings;
  include_files: { limit_tokens: boolean; max_tokens: number };
  language_extension_map_org: Record<string, string[]>;
  [table: string]: unknown;
}

let cached: Settings | undefined;

export function getSettings(settingsDir: string = SETTINGS_DIR): Settings {
  if (cached && settingsDir === SETTINGS_DIR) return cached;

  const merged: Record<string, unknown> = {};
  for (const file of SETTINGS_FILES) {
    const fullPath = join(settingsDir, file);
    if (!existsSync(fullPath)) {
      throw new Error(`Settings file not found: ${fullPath}`);
    }
    const parsed = parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
    for (const [table, value] of Object.entries(parsed)) {
      const existing = merged[table];
      merged[table] =
        isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
    }
  }

  const settings = merged as unknown as Settings;
  if (settingsDir === SETTINGS_DIR) cached = settings;
  return settings;
}

export function getPromptTemplate(name: string): PromptTemplate {
  const table = getSettings()[name];
  if (
    !isPlainObject(table) ||
    typeof table["system"] !== "string" ||
    typeof table["user"] !== "string"
  ) {
    throw new Error(`Could not find valid system/user prompt settings for: ${name}`);
  }
  return { system: table["system"], user: table["user"] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
