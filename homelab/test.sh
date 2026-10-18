#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../tests"
mapfile -t tests < <(find unit -maxdepth 1 -name 'homelab-*.test.js' -print | sort)
test -f unit/homelab-subscription-quota.test.js
test -f unit/homelab-subscription-auth.test.js
test -f unit/homelab-subscription-usage.test.js
nice -n 19 env UV_THREADPOOL_SIZE=4 ./node_modules/.bin/vitest run \
  unit/codex-gpt6-lite.test.js \
  unit/openai-responses-terminal-event.test.js \
  unit/codex-tool-normalization.test.js \
  unit/codex-fast-capacity.test.js \
  unit/responses-abort-terminal.test.js \
  unit/github-monthly-usage-lock.test.js \
  unit/account-fallback-4xx.test.js \
  unit/codex-spark-quota-tracking.test.js \
  unit/claude-reset-grants.test.js \
  unit/usage-dispatch.test.js \
  unit/antigravity-quota-routing.test.js \
  unit/antigravity-weekly-quota.test.js \
  unit/strict-proxy-enforcement.test.js \
  unit/provider-quota-visibility.test.js \
  unit/quota-auto-ping.test.js \
  unit/auth-status.test.js \
  "${tests[@]}" --configLoader=runner --no-cache \
  --maxWorkers=4 --maxConcurrency=4 --silent --reporter=dot
