#!/usr/bin/env bash
set -euo pipefail
image=${1:?image required}
container="9router-smoke-${GITHUB_RUN_ID:-local}"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
nice -n 19 docker run --detach --name "$container" \
  --cpus=2 --memory=1g --pids-limit=256 \
  --publish 127.0.0.1:20128:20128 \
  --env REQUIRE_API_KEY=true \
  --env JWT_SECRET=isolated-build-smoke-test \
  --env INITIAL_PASSWORD=isolated-build-smoke-test "$image" >/dev/null
for attempt in {1..60}; do
  if curl --fail --silent http://127.0.0.1:20128/api/health >/dev/null; then
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:20128/api/settings)
    test "$status" = 401
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:20128/v1/models)
    test "$status" = 401
    echo "Health and unauthenticated-access smoke checks passed."
    exit 0
  fi
  sleep 2
done
docker logs --tail=50 "$container"
exit 1
