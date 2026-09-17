#!/usr/bin/env bash
# Replays qodo-cover's own recorded LLM responses for its TypeScript calculator example
# through this port. No API key needed. Proves the TS loop reproduces the Python tool's
# behaviour on upstream's reference scenario (mocha + nyc + Cobertura).
#
# Result on 2026-09-17 (Node 22.22): coverage 48.31% -> 77.97%, 3 of 4 generated tests kept,
# 1 rolled back for not increasing coverage, final suite 6 passing.
set -euo pipefail

PORT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --depth 1 https://github.com/qodo-ai/qodo-cover.git "$WORK/qodo-cover"
cp -r "$WORK/qodo-cover/templated_tests/typescript_calculator" "$WORK/calc"
cd "$WORK/calc"
rm -f package-lock.json
# Drop the bundler/lint deps; only the test toolchain is needed.
node -e '
  const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json"));
  for (const k of ["@parcel/transformer-sass", "parcel", "eslint", "mocha-junit-reporter"]) delete p.devDependencies[k];
  p.dependencies = {}; fs.writeFileSync("package.json", JSON.stringify(p, null, 2));'
npm install --no-audit --no-fund

mkdir -p stored_responses
cp "$WORK"/qodo-cover/stored_responses/typescript_calculator_responses_*.yml stored_responses/

(cd "$PORT_DIR" && npm run build)
TEST_NAME=typescript_calculator node "$PORT_DIR/dist/cli.js" \
  --source-file-path src/modules/Calculator.ts \
  --test-file-path tests/Calculator.test.ts \
  --test-command "npm run test" \
  --code-coverage-report-path coverage/cobertura-coverage.xml \
  --max-run-time-sec 120

npm run test
