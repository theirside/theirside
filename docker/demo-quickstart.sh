#!/usr/bin/env bash
# Runs the theirside.dev demo (docs/site/demo.md) against docker/compose.demo.yml the way a
# visitor would: in an empty directory, with the file saved as theirside-demo.yml. The only
# difference is the images, swapped in through a compose override (the file itself is not
# edited).
#
#   docker/demo-quickstart.sh ghcr.io/theirside/collector:ci ghcr.io/theirside/demo-app:ci \
#     ghcr.io/theirside/chaos-provider:ci
#
# Checks: `run --rm ready` prints the ready line with a setup link, the first account is
# created with it, one provider endpoint is broken through the chaos provider (the first
# "try" on the page), an incident opens for it and its open alert reaches the alert sink.
# Exits non-zero on any failure; always tears the stack down (volumes too). Needs ports
# 4318 and 4010 free; takes about 5 minutes.
set -euo pipefail

COLLECTOR="${1:?usage: $0 <collector image> <demo-app image> <chaos-provider image>}"
DEMO_APP="${2:?usage: $0 <collector image> <demo-app image> <chaos-provider image>}"
CHAOS="${3:?usage: $0 <collector image> <demo-app image> <chaos-provider image>}"
SRC="$(cd "$(dirname "$0")" && pwd)/compose.demo.yml"
BASE="http://localhost:4318"
CHAOS_URL="http://localhost:4010"
PROVIDER="acmecards.test"
ENDPOINT="/v2/cards/:id/activate"
INCIDENT_WAIT_S="${INCIDENT_WAIT_S:-480}"
EMAIL="demo-check@example.test"
PASSWORD="demo check $(date +%s) password"

WORK="$(mktemp -d)"
cd "$WORK"
cp "$SRC" theirside-demo.yml
cat > image.override.yml <<EOF
services:
  collector: { image: ${COLLECTOR}, pull_policy: never }
  seed: { image: ${COLLECTOR}, pull_policy: never }
  ready: { image: ${COLLECTOR}, pull_policy: never }
  demo: { image: ${DEMO_APP}, pull_policy: never }
  chaos: { image: ${CHAOS}, pull_policy: never }
EOF
dc() { docker compose -f theirside-demo.yml -f image.override.yml "$@"; }

fail() {
  echo "::error::demo quickstart: $*" >&2
  exit 1
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then dc logs --tail 150 || true; fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

echo "== run --rm ready"
t0=$(date +%s)
out="$(dc run --rm -T ready)" || fail "run --rm ready failed: $out"
echo "$out"
line="$(printf '%s\n' "$out" | grep -m1 '^Theirside demo is ready' || true)"
[ -n "$line" ] || fail "no ready line"
token="$(printf '%s' "$line" | sed -nE 's/.*\/setup\?token=([A-Za-z0-9]+).*/\1/p')"
[ -n "$token" ] || fail "no setup link in the ready line: $line"
echo "ready after $(($(date +%s) - t0)) s"

echo "== first account with the setup link"
jar="$WORK/cookies"
body="$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" --arg t "$token" \
  '{email: $e, name: "Demo check", password: $p, setupCode: $t}')"
code="$(curl -sS -o setup.json -w '%{http_code}' -c "$jar" \
  -H 'content-type: application/json' -d "$body" "$BASE/v1/auth/setup")"
[ "$code" = 200 ] || fail "setup returned $code: $(cat setup.json)"

echo "== seeded history"
curl -sS -b "$jar" "$BASE/v1/admin/providers" -o providers.json
jq -e --arg p "$PROVIDER" '.providers | any(.name == $p)' providers.json >/dev/null ||
  fail "$PROVIDER missing: $(jq -c '[.providers[].name]' providers.json)"

echo "== break $ENDPOINT (40% 503s)"
curl -sS -f -X POST "$CHAOS_URL/__chaos/rules" \
  -d "{\"path\":\"$ENDPOINT\",\"method\":\"POST\",\"errorRate\":0.4,\"errorStatus\":503,\"durationSeconds\":600}" >/dev/null ||
  fail "chaos rule refused"
t1=$(date +%s)

echo "== incident opens (up to ${INCIDENT_WAIT_S} s)"
incident=""
while [ -z "$incident" ]; do
  [ $(($(date +%s) - t1)) -lt "$INCIDENT_WAIT_S" ] || fail "no open incident for $PROVIDER $ENDPOINT after ${INCIDENT_WAIT_S} s"
  sleep 10
  curl -sS -b "$jar" "$BASE/v1/admin/incidents?status=open&provider=$PROVIDER" -o incidents.json || continue
  incident="$(jq -r --arg e "$ENDPOINT" \
    '[.incidents[] | select(any(.endpoints[]; .endpoint == $e))][0].id // empty' incidents.json)"
done
echo "incident $incident opened $(($(date +%s) - t1)) s after the fault"

echo "== open alert in the sink"
for _ in $(seq 1 12); do
  curl -sS "$CHAOS_URL/__alerts" -o alerts.json
  if jq -e '.alerts | any(.event == "open" and .signatureValid == true)' alerts.json >/dev/null; then
    echo "demo quickstart OK"
    exit 0
  fi
  sleep 5
done
fail "no signed open alert in the sink: $(jq -c '[.alerts[] | {event, signatureValid}]' alerts.json)"
