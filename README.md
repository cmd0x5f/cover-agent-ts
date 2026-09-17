# cover-agent-ts

A TypeScript port of [qodo-ai/qodo-cover](https://github.com/qodo-ai/qodo-cover) (`cover-agent` 0.3.10): coverage-driven unit test generation with an LLM.

The loop is unchanged from upstream. It runs your tests, reads the coverage report, and asks the model for new tests. Each proposed test is inserted and kept only if it **passes** and **increases coverage**; otherwise it is rolled back. This repeats until the target is reached or iterations run out.

See [MIGRATION.md](./MIGRATION.md) for the file-by-file mapping, replaced dependencies, intentional behaviour changes, and how parity with the Python tool was verified.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite` for the attempts log)
- git (only for `--diff-coverage`)

## Install

```bash
npm ci
npm run build
npm link            # optional: puts `cover-agent` and `cover-agent-report` on PATH
```

## Quick start: Vitest + Istanbul, one source file

```bash
cover-agent \
  --source-file-path src/features/transfers/fees.ts \
  --test-file-path src/features/transfers/fees.test.ts \
  --project-root . \
  --code-coverage-report-path coverage/cobertura-coverage.xml \
  --coverage-type cobertura \
  --test-command "npx vitest run src/features/transfers/fees.test.ts \
      --coverage.enabled --coverage.provider=istanbul --coverage.reporter=cobertura \
      --coverage.include=src/features/transfers/fees.ts \
      --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 \
      --coverage.thresholds.branches=0 --coverage.thresholds.statements=0" \
  --model "bedrock/eu.anthropic.claude-sonnet-4-5-20250929-v1:0" \
  --desired-coverage 90 \
  --max-iterations 3 \
  --max-run-time-sec 120
```

Things that will otherwise bite:

- **Coverage thresholds.** If `vitest.config.*` sets `coverage.thresholds`, Vitest exits non-zero below them. The initial run then fails with `Fatal: Error running test command`. Override them to `0` in the test command, as above.
- **Scope the run.** Every candidate test triggers a full run of `--test-command`. Point it at one test file and one `--coverage.include`, not the whole suite.
- **Timeout.** `--max-run-time-sec` defaults to 30. Vitest with Istanbul instrumentation on a cold cache can exceed that. On timeout the whole process group is killed, including workers.
- **Monorepo.** Run from the package root (or pass `--test-command-dir`) so report paths resolve exactly. If a path can only be matched by suffix and several files match, a warning is logged.

### Diff coverage (tests for what a merge request changed)

```bash
cover-agent ... --diff-coverage --branch origin/develop
```

Only lines added or modified relative to `--branch` count toward the target. A source file with no changes is reported as 100%, so the loop exits immediately.

## Models

Model names keep LiteLLM's `<provider>/<model-id>` shape.

| Model string | Provider | Credentials |
|---|---|---|
| `bedrock/<model-or-inference-profile-id>` | Amazon Bedrock | AWS default chain: env vars, `AWS_PROFILE` + `aws sso login`, instance role. Region from `AWS_REGION`. |
| `anthropic/<id>` or bare `claude-*` | Anthropic API | `ANTHROPIC_API_KEY` |
| bare `gpt-*`, `o1*`, `o3*`, `o4*` | OpenAI | `OPENAI_API_KEY` |
| `openai/<id>` | Any OpenAI-compatible endpoint at `--api-base` | optional `OPENAI_API_KEY` |
| `ollama/<id>` | Ollama at `<api-base>/v1` (default `http://localhost:11434`) | none |
| `openrouter/<id>` | OpenRouter | `OPENROUTER_API_KEY` |

To add another provider, add a case to `src/ai/modelRegistry.ts` using any Vercel AI SDK provider package.

## Record and replay

```bash
cover-agent ... --record-mode     # writes stored_responses/<dir>_responses_<hash>.yml
cover-agent ...                   # replays automatically when a matching recording exists
```

Recordings are keyed by a hash of the source and test file contents. They are **format-compatible with the Python tool** in both directions. Replay is useful for deterministic CI checks of the tooling itself, with no model calls. The directory name part can be pinned with `TEST_NAME`.

## Outputs

| File | What |
|---|---|
| `run.log` | Full log of the run |
| `cover_agent_unit_test_runs.db` | SQLite. Every attempt with status, reason, prompt, test code, stdout/stderr, and before/after test file. Same schema as upstream. Override the path with `--log-db-path` or `LOG_DB_PATH`. |
| `test_results.html` | Report rendered from the DB. Regenerate with `cover-agent-report --path-to-db ... --report-filepath ...` |

`--suppress-log-files` disables all three.

## Programmatic use

```ts
import { buildConfig, CoverAgent, configureLogging } from "cover-agent-ts";

configureLogging({ generateLogFiles: false });
const agent = await CoverAgent.create(
  buildConfig({
    sourceFilePath: "src/fees.ts",
    testFilePath: "src/fees.test.ts",
    codeCoverageReportPath: "coverage/cobertura-coverage.xml",
    testCommand: "npx vitest run src/fees.test.ts --coverage.enabled --coverage.thresholds.lines=0",
    model: "ollama/qwen2.5-coder:14b",
  }),
);
const { exitCode, finalCoverage, totalInputTokens } = await agent.run();
```

`CoverAgent.create` accepts `{ agentCompletion, runner, git, modelResolver }` for injecting your own prompt strategy, sandboxed runner, or model routing.

## Development

```bash
npm run typecheck
npm test                                # 65 tests, including a real Vitest + Istanbul e2e run
./scripts/replay-upstream-fixture.sh    # replays upstream's recorded run through this port
```

## Caveats carried over from upstream

- Passing tests that increase coverage are not necessarily *good* tests. Tests can assert whatever the code currently does, including bugs. Treat generated tests as drafts for review. Consider a mutation-testing gate (e.g. StrykerJS) before trusting them.
- The loop is deterministic orchestration around single LLM calls. There is no agentic exploration of the codebase. Context is limited to the source file, the test file, and `--included-files`.

## License

AGPL-3.0-only, inherited from qodo-cover. This is a derivative work; see [LICENSE](./LICENSE).
