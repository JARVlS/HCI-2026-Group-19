#!/usr/bin/env bash
# Smoke test under the real Workers runtime: starts tests/fake_anthropic.py and `pywrangler dev`
# (with tests/smoke.env and its own local D1 in .wrangler/smoke-state), runs tests/smoke.py,
# then stops both servers. Usage, from backend/:  bash tests/smoke.sh
set -euo pipefail
set -m  # background jobs get their own process group, so we can stop wrangler and workerd too
cd "$(dirname "$0")/.."

PORT=8787
STATE=.wrangler/smoke-state
LOG=.wrangler/smoke-dev.log
mkdir -p .wrangler

stop() {
  for pid in ${FAKE_PID:-} ${DEV_PID:-}; do kill -- "-$pid" 2>/dev/null || true; done
}
trap stop EXIT

# A fresh database every run: all migrations are applied from scratch, and the large rows of the
# sync checks do not pile up across runs.
rm -rf "$STATE"
uv run pywrangler d1 migrations apply hci-grp19 --local --persist-to "$STATE" > /dev/null
# A payload that is not JSON (POST /api/events cannot store one): the admin log routes must cope.
uv run pywrangler d1 execute hci-grp19 --local --persist-to "$STATE" --command \
  "INSERT INTO events VALUES ('smoke-bad-json', 'smoke-bad-json-user', NULL, 'turn_sent', '{not json',
   '2026-11-16T12:00:00.000Z', '2026-11-16T12:00:00.000Z')" > /dev/null
uv run python tests/fake_anthropic.py --port 8790 &
FAKE_PID=$!
uv run pywrangler dev --port "$PORT" --env-file tests/smoke.env --persist-to "$STATE" > "$LOG" 2>&1 &
DEV_PID=$!

for _ in $(seq 1 60); do
  grep -q "Ready on" "$LOG" && break
  kill -0 "$DEV_PID" 2>/dev/null || { cat "$LOG"; exit 1; }
  sleep 2
done
grep -q "Ready on" "$LOG" || { echo "pywrangler dev did not start, see $LOG"; exit 1; }

uv run --group test python tests/smoke.py --base-url "http://localhost:$PORT" --admin-token smoke-admin-token
