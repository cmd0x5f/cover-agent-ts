/**
 * Port of UnitTestGenerator.get_code_language / UnitTestValidator.get_code_language
 * (identical duplicated methods upstream).
 */
import { getSettings } from "../config/settings.js";

export function getCodeLanguage(sourceFilePath: string): string {
  const map = getSettings().language_extension_map_org;
  const extensionToLanguage = new Map<string, string>();
  for (const [language, extensions] of Object.entries(map)) {
    for (const ext of extensions) extensionToLanguage.set(ext, language);
  }
  // Python: "." + source_file_path.rsplit(".")[-1]
  const parts = sourceFilePath.split(".");
  const extension = "." + parts[parts.length - 1];
  return (extensionToLanguage.get(extension) ?? "unknown").toLowerCase();
}
