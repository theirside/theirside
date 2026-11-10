#!/usr/bin/env bash
# Runs the theirside.dev Quick start against docker/compose.selfhost.yml, the way a new user
# would: in an empty directory, with the file saved as compose.yml. The only difference is the
# collector image, swapped in through a compose override (the file itself is not edited).
#
#   docker/selfhost-quickstart.sh ghcr.io/theirside/collector:ci
#
# Checks: up -d --wait, the /setup line in the logs, the first account created through the
# setup API with that token, the generated API key read back, one ingest batch accepted.
# Exits non-zero on any failure; always tears the stack down (volumes too).
set -euo pipefail

IMAGE="${1:?usage: $0 <collector image>}"
SRC="$(cd "$(dirname "$0")" && pwd)/compose.selfhost.yml"
BASE="http://localhost:4318"
EMAIL="quickstart@example.test"
PASSWORD="quickstart check $(date +%s) password"

WORK="$(mktemp -d)"
cd "$WORK"
cp "$SRC" compose.yml
cat > image.override.yml <<EOF
services:
  collector:
    image: ${IMAGE}
    pull_policy: never
EOF
dc() { docker compose -f compose.yml -f image.override.yml "$@"; }

fail() {
  echo "::error::selfhost quickstart: $*" >&2
  exit 1
}
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then dc logs --tail 200 || true; fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

echo "== up -d --wait ($IMAGE)"
dc up -d --wait

echo "== setup link from the logs"
line="$(dc logs collector | grep -m1 "/setup" || true)"
[ -n "$line" ] || fail "no /setup line in the collector log"
token="$(printf '%s' "$line" | sed -nE 's/.*\/setup\?token=([A-Za-z0-9]+).*/\1/p')"
[ -n "$token" ] || fail "no token in the setup line: $line"
printf '%s' "$line" | grep -q "to create the first account" || fail "unexpected setup line: $line"
dc logs collector | grep -q "tsd_live_" && fail "the generated API key appears in the log"

echo "== first account through the setup API"
jar="$WORK/cookies"
body="$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" --arg t "$token" \
  '{email: $e, name: "Quickstart", password: $p, setupCode: $t}')"
code="$(curl -sS -o setup.json -w '%{http_code}' -c "$jar" \
  -H 'content-type: application/json' -d "$body" "$BASE/v1/auth/setup")"
[ "$code" = 200 ] || fail "setup returned $code: $(cat setup.json)"

echo "== generated API key"
code="$(curl -sS -o keys.json -w '%{http_code}' -b "$jar" "$BASE/v1/admin/api-keys")"
[ "$code" = 200 ] || fail "api-keys returned $code: $(cat keys.json)"
key="$(jq -r '[.apiKeys[] | select(.key != null and .revokedAt == null)][0].key // empty' keys.json)"
[[ "$key" =~ ^tsd_live_[A-Za-z0-9]+$ ]] || fail "no generated key in: $(cat keys.json)"

echo "== one ingest batch"
batch="$(jq -n --argjson ts "$(($(date +%s) * 1000))" '{
  protocol: 1, sdk: {name: "@theirside/sdk", version: "0.0.0-quickstart"},
  service: "quickstart", environment: "ci", dropped: 0,
  events: [{ts: $ts, provider: "Acme Cards", host: "api.acmecards.test", method: "POST",
            endpoint: "/v2/cards/:id/activate", status: 200, durationMs: 120, outcome: "ok"}]
}')"
code="$(curl -sS -o ingest.json -w '%{http_code}' -H "authorization: Bearer $key" \
  -H 'content-type: application/json' -d "$batch" "$BASE/v1/ingest")"
[ "$code" = 202 ] || fail "ingest returned $code: $(cat ingest.json)"

echo "== the token is spent"
code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$token" '{email: "late@example.test", name: "Late", password: "another long password", setupCode: $t}')" \
  "$BASE/v1/auth/setup")"
[ "$code" = 409 ] || fail "a second setup returned $code, expected 409"

echo "selfhost quickstart OK"
