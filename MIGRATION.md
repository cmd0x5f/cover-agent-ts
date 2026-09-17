# Migration notes: qodo-cover (Python) → cover-agent-ts

Ported from `qodo-ai/qodo-cover` at commit `adcf55b` (2025-06-23, release 0.3.10).

## Scope

**Ported:** the single-file `cover-agent` command and everything it depends on.

**Not ported:**

| Upstream | Why |
|---|---|
| `main_full_repo.py`, `lsp_logic/**` (~10k lines) | Full-repo mode discovers test/source pairs through a vendored *Python* language server (Jedi) and tree-sitter. It cannot analyse a TS codebase. |
| Weights & Biases tracing | Optional upstream. Not relevant to this port. |
| `file_preprocessor.py` | Python-only, and never called upstream. |
| `analyze_test_against_context` usage | Only used by full-repo mode. The method and prompt are kept for interface parity. |
| Docker / PyInstaller build helpers, `tests_integration/` | Python packaging and container orchestration. |

## File mapping

| Python | TypeScript |
|---|---|
| `main.py` | `src/main.ts`, `src/cli.ts` |
| `cover_agent.py` | `src/coverAgent.ts` |
| `unit_test_generator.py` | `src/unitTestGenerator.ts` |
| `unit_test_validator.py` | `src/unitTestValidator.ts` |
| `coverage_processor.py` | `src/coverage/coverageProcessor.ts` |
| *(diff-cover package)* | `src/coverage/diffCoverage.ts` |
| `ai_caller.py` | `src/ai/aiCaller.ts` |
| *(LiteLLM routing)* | `src/ai/modelRegistry.ts` |
| `ai_caller_replay.py` | `src/ai/aiCallerReplay.ts` |
| `record_replay_manager.py` | `src/ai/recordReplayManager.ts` |
| `agent_completion_abc.py` | `src/agentCompletion/types.ts` |
| `default_agent_completion.py` | `src/agentCompletion/defaultAgentCompletion.ts` |
| `unit_test_db.py` | `src/unitTestDb.ts`, `src/reportCli.ts` |
| `report_generator.py` | `src/reportGenerator.ts` |
| `runner.py` | `src/runner.ts` |
| `custom_logger.py` | `src/logger.ts` |
| `settings/config_loader.py` | `src/config/settings.ts` |
| `settings/config_schema.py` | `src/config/schema.ts` |
| `settings/token_handling.py`, `utils.get_included_files` | `src/utils/includedFiles.ts` |
| `utils.load_yaml`, `utils.try_fix_yaml` | `src/utils/loadYaml.ts` |
| `settings/*.toml` | `settings/*.toml` (**verbatim copies**) |

## Dependency mapping

| Python | TypeScript | Notes |
|---|---|---|
| litellm | `ai` + `@ai-sdk/*` providers | Same `provider/model` strings. Providers are imported lazily. |
| jinja2 | nunjucks | Configured for byte-identical output (see verification). |
| dynaconf | smol-toml | Same TOML files, shallow merge. |
| sqlalchemy | `node:sqlite` | Same table and columns. |
| diff-cover | native `git diff -U0` parsing | See behaviour changes. |
| PyYAML | js-yaml (CORE schema, duplicate keys allowed) | See behaviour changes. |
| tenacity | retry loop in `AICaller` | Same attempts (`model_retries`) and 1s fixed wait. |
| fuzzywuzzy | `tokenSortRatio` in `src/utils/pyCompat.ts` | Levenshtein-ratio variant. |
| tiktoken | ~4 chars/token estimate | Only used to size `--included-files` clipping. |
| argparse | commander | Same flags and defaults; `--diff-coverage` and `--use-report-coverage-feature-flag` still conflict. |

## Intentional behaviour changes

Each is a bug upstream or an unavoidable platform difference.

1. **Path-aware coverage matching.** Upstream matched report entries by `filename.endswith(basename(source))`. In a monorepo, `index.ts` merged the coverage of every `index.ts` in the report, and `Calculator.ts` also matched `MyCalculator.ts`. Paths now resolve against Cobertura `<source>` roots, the report directory, and cwd. A segment-aware suffix match is used only as a fallback.
2. **Test file re-read every iteration.** Upstream read the test file once at start-up. From iteration 2 on, the model never saw the tests it had already added.
3. **`--included-files` works.** argparse's `type=list` split each path into characters, and the generator received the raw list instead of file contents. With no included files, the literal text `None` was rendered into every generation prompt.
4. **`--use-report-coverage-feature-flag` works with LCOV.** Upstream crashed: the LCOV parser returned a tuple where a per-file dict was expected.
5. **Sorted line numbers** in the coverage summary sent to the model. Upstream used `list(set)` order.
6. **Diff coverage with no changes** in the source file reports 100% (nothing to cover). Upstream reported 0% and spent every iteration on tests that could never count.
7. **HTML report escapes content.** JSX in generated tests was rendered as markup. PASS/FAIL colours now apply.
8. **Timeout kills the process group**, not just the shell. Vitest/Jest workers no longer outlive the timeout.
9. **An un-insertable test returns a FAIL attempt.** Upstream returned `None` and then crashed writing to the DB.
10. **YAML booleans.** js-yaml's CORE schema keeps `yes`/`no`/`on`/`off` as strings; PyYAML turned them into booleans. None of cover-agent's response schemas rely on this.
11. **Async API.** `CoverAgent.create()` replaces the constructor. `run()` returns an exit code instead of calling `sys.exit(2)`.
12. **Caller names are explicit.** Python derived record/replay keys by walking the call stack. The port passes the same snake_case names explicitly.

Kept as-is on purpose, even though they are questionable:

- The quirky `try_fix_yaml` fallback chain.
- The "in N iterations" off-by-one in the final log line.
- JaCoCo parsing.
- The pytest-specific branch of `--run-each-test-separately`.

## How parity was verified

1. **Prompt rendering is byte-identical to Jinja2.** `tests/prompts.test.ts` renders the three prompts from upstream's recorded TypeScript calculator run and compares them to the recorded prompts character for character.
2. **Record/replay hashes match Python.** The same test checks `sha256(repr(prompt_dict))` against the hashes Python wrote (`8b7b17a729c4`, `daf934acdf2b`, `894f1e2b37de`). Recordings are interchangeable.
3. **Upstream's reference scenario reproduces.** `scripts/replay-upstream-fixture.sh` replays Qodo's own recorded LLM responses through the port, against the real mocha + nyc project. Result: 48.31% → 77.97%, 3 of 4 tests kept, 1 rolled back for not increasing coverage, final suite green.
4. **Real Vitest + Istanbul loop.** `tests/e2e.vitest.test.ts` runs the full agent against a real Vitest project with coverage thresholds configured. It checks:
   - a failing test is rolled back and analysed;
   - a non-increasing test is rolled back;
   - kept tests persist;
   - iteration 2 sees both the updated test file and the failure analysis;
   - the attempts DB and report are written.
5. **Unit tests.** Ported from `test_load_yaml.py`, `test_coverage_processor.py` and `test_unit_test_validator.py`, plus new ones for the changes above. 65 tests in total.

Toolchain at time of porting: Node 22.22, TypeScript 7.0, Vitest 5.0, AI SDK 7.0.
