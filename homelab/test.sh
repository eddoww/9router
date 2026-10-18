#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../tests"
mapfile -t tests < <(find unit -maxdepth 1 -name 'homelab-*.test.js' -print | sort)
nice -n 19 env UV_THREADPOOL_SIZE=4 ./node_modules/.bin/vitest run \
  unit/codex-gpt6-lite.test.js \
  unit/openai-responses-terminal-event.test.js \
  unit/codex-tool-normalization.test.js \
  unit/codex-fast-capacity.test.js \
  unit/responses-abort-terminal.test.js \
  "${tests[@]}" --maxWorkers=4 --maxConcurrency=4 --silent --reporter=dot
