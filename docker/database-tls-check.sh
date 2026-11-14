#!/usr/bin/env bash
# The collector verifies its database's TLS certificate against a custom CA
# (THEIRSIDE_DATABASE_CA_FILE with sslmode=verify-full), against a Postgres whose
# certificate is signed by a throwaway CA made here:
#   1. verify-full + the CA file          -> ready
#   2. verify-full without the CA file    -> refused (no trusted chain)
#   3. the CA file, wrong host name       -> refused (name not in the certificate)
#   4. the image's RDS bundle as the CA   -> refused (this server isn't RDS); the bundle is there
#   5. sslmode=no-verify (testing only)   -> ready, with the startup warning and the admin notice
# Case 1 must show neither the warning nor the notice.
#
#   docker/database-tls-check.sh ghcr.io/theirside/collector:<tag>
# Needs Docker and openssl; publishes no ports. CI: job "Database TLS".
set -euo pipefail
IMAGE="${1:?usage: docker/database-tls-check.sh <collector image>}"
RUN="tsdbtls-$$"
WORK="$(mktemp -d)"
NET="$RUN-net"
cleanup() {
  docker rm -f "$RUN-pg" "$RUN-c" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== a throwaway CA and a server certificate for db.tls.test"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Theirside test CA" \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=db.tls.test" \
  -keyout "$WORK/server.key" -out "$WORK/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:db.tls.test\n' >"$WORK/san.ext"
openssl x509 -req -in "$WORK/server.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
  -CAcreateserial -days 2 -extfile "$WORK/san.ext" -out "$WORK/server.crt" 2>/dev/null
chmod 644 "$WORK"/*

echo "== Postgres with TLS (names: db.tls.test, other.tls.test)"
docker network create "$NET" >/dev/null
docker run -d --name "$RUN-pg" --network "$NET" \
  --network-alias db.tls.test --network-alias other.tls.test \
  -e POSTGRES_USER=ts -e POSTGRES_PASSWORD=ts -e POSTGRES_DB=ts \
  -v "$WORK:/certs:ro" --entrypoint sh postgres:16-alpine -c '
    mkdir -p /var/lib/postgresql/tls &&
    cp /certs/server.crt /certs/server.key /var/lib/postgresql/tls/ &&
    chown -R postgres:postgres /var/lib/postgresql/tls && chmod 600 /var/lib/postgresql/tls/server.key &&
    exec docker-entrypoint.sh postgres -c ssl=on \
      -c ssl_cert_file=/var/lib/postgresql/tls/server.crt -c ssl_key_file=/var/lib/postgresql/tls/server.key' >/dev/null
for _ in $(seq 60); do
  docker exec "$RUN-pg" pg_isready -U ts -d ts >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$RUN-pg" pg_isready -U ts -d ts >/dev/null || fail "Postgres did not start"
sleep 2

# collector <url> [CA file inside the container]; prints ready or the database error it logged
collector() {
  docker rm -f "$RUN-c" >/dev/null 2>&1 || true
  local ca=()
  [ -n "${2:-}" ] && ca=(-e "THEIRSIDE_DATABASE_CA_FILE=$2")
  docker run -d --name "$RUN-c" --network "$NET" -v "$WORK/ca.crt:/certs/ca.crt:ro" \
    -e "DATABASE_URL=$1" -e THEIRSIDE_BOOTSTRAP_API_KEY=tsd_live_tlscheck0000000000000000 \
    -e THEIRSIDE_ADMIN_TOKEN=tls-check-admin-token-000 \
    ${ca[@]+"${ca[@]}"} "$IMAGE" >/dev/null
  for _ in $(seq 40); do
    if docker exec "$RUN-c" node -e "fetch('http://127.0.0.1:4318/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      echo ready
      return
    fi
    local err
    err="$(docker logs "$RUN-c" 2>&1 | grep -o 'database not reachable yet ([^)]*)' | head -1 || true)"
    if [ -n "$err" ]; then
      echo "$err"
      return
    fi
    sleep 1
  done
  echo "neither ready nor a database error: $(docker logs "$RUN-c" 2>&1 | tail -3)"
}

URL="postgres://ts:ts@db.tls.test:5432/ts"

# the startup WARN line, and what GET /v1/admin/system tells admins
warned() { docker logs "$RUN-c" 2>&1 | grep -c 'is not verified' || true; }
notice() {
  docker exec "$RUN-c" node -e "fetch('http://127.0.0.1:4318/v1/admin/system',{headers:{authorization:'Bearer tls-check-admin-token-000'}}).then(r=>r.json()).then(j=>console.log(j.databaseTls.warning===null?'none':'warning'))"
}

echo "== 1. verify-full with the CA file"
r="$(collector "$URL?sslmode=verify-full" /certs/ca.crt)"
[ "$r" = ready ] || fail "expected ready, got: $r"
[ "$(warned)" = 0 ] || fail "a verified connection logged the TLS warning"
[ "$(notice)" = none ] || fail "a verified connection shows the admin notice"
echo "   $r; no warning, no notice"

echo "== 2. verify-full without the CA file"
r="$(collector "$URL?sslmode=verify-full")"
# Postgres sends only its own certificate, so Node can't build a chain to a trusted root
[[ "$r" == *"unable to verify"* || "$r" == *"self-signed certificate"* ]] ||
  fail "expected a certificate verification error, got: $r"
echo "   $r"

echo "== 3. the CA file, but a host name the certificate doesn't name"
r="$(collector "postgres://ts:ts@other.tls.test:5432/ts?sslmode=verify-full" /certs/ca.crt)"
[[ "$r" == *"does not match certificate"* ]] || fail "expected a host name mismatch, got: $r"
echo "   $r"

echo "== 4. the image's RDS bundle as the CA (this server isn't RDS)"
n="$(docker run --rm --entrypoint sh "$IMAGE" -c 'grep -c "BEGIN CERTIFICATE" /app/certs/rds-global-bundle.pem')"
[ "$n" -gt 50 ] || fail "the RDS bundle in the image has $n certificates"
r="$(collector "$URL?sslmode=verify-full" /app/certs/rds-global-bundle.pem)"
[[ "$r" == *"certificate"* && "$r" != ready ]] || fail "expected a certificate error, got: $r"
echo "   $n certificates in /app/certs/rds-global-bundle.pem; $r"

echo "== 5. sslmode=no-verify (encrypted, certificate not checked: for testing only)"
r="$(collector "$URL?sslmode=no-verify")"
[ "$r" = ready ] || fail "expected ready, got: $r"
[ "$(warned)" = 1 ] || fail "expected one startup TLS warning, got $(warned)"
[ "$(notice)" = warning ] || fail "expected the admin notice"
echo "   $r; $(docker logs "$RUN-c" 2>&1 | grep -o 'The database connection to [^:]*: its TLS' | head -1)…; admin notice shown"

echo "database TLS check OK"
