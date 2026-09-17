/**
 * Port of cover_agent/custom_logger.py
 *
 * Same line format as Python's logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s").
 * Console output goes to stderr (Python's StreamHandler default) so that LLM output streamed
 * to stdout stays separable. The log file is truncated once per process, not once per logger.
 */
import { appendFileSync, writeFileSync } from "node:fs";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

interface LoggingState {
  logFilePath: string | undefined;
  consoleLevel: LogLevel;
  fileLevel: LogLevel;
  silent: boolean;
}

const state: LoggingState = {
  logFilePath: undefined,
  consoleLevel: "INFO",
  fileLevel: "INFO",
  silent: false,
};

export function configureLogging(options: {
  generateLogFiles: boolean;
  logFilePath?: string;
  consoleLevel?: LogLevel;
  silent?: boolean;
}): void {
  state.consoleLevel = options.consoleLevel ?? "INFO";
  state.silent = options.silent ?? false;
  if (options.generateLogFiles && options.logFilePath) {
    writeFileSync(options.logFilePath, "");
    state.logFilePath = options.logFilePath;
  } else {
    state.logFilePath = undefined;
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`
  );
}

class CustomLogger implements Logger {
  constructor(private readonly name: string) {}

  private write(level: LogLevel, message: string): void {
    const line = `${timestamp()} - ${this.name} - ${level} - ${message}`;
    if (!state.silent && LEVEL_ORDER[level] >= LEVEL_ORDER[state.consoleLevel]) {
      process.stderr.write(line + "\n");
    }
    if (state.logFilePath && LEVEL_ORDER[level] >= LEVEL_ORDER[state.fileLevel]) {
      appendFileSync(state.logFilePath, line + "\n");
    }
  }

  debug(message: string): void {
    this.write("DEBUG", message);
  }
  info(message: string): void {
    this.write("INFO", message);
  }
  warn(message: string): void {
    this.write("WARNING", message);
  }
  error(message: string): void {
    this.write("ERROR", message);
  }
}

export function getLogger(name: string): Logger {
  return new CustomLogger(name);
}
