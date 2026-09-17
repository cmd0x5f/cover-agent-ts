#!/usr/bin/env node
/** Port of unit_test_db.dump_to_report_cli */
import { Command } from "commander";
import { UnitTestDB } from "./unitTestDb.js";

const program = new Command()
  .name("cover-agent-report")
  .description("Generate a unit test report.")
  .option("--path-to-db <path>", "Path to the SQLite database file.", "cover_agent_unit_test_runs.db")
  .option("--report-filepath <path>", "Path to the HTML report file.", "test_results.html")
  .parse();

const { pathToDb, reportFilepath } = program.opts<{ pathToDb: string; reportFilepath: string }>();
const db = new UnitTestDB(pathToDb);
db.dumpToReport(reportFilepath);
db.close();
