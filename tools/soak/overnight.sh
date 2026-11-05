#!/usr/bin/env bash
# Start the overnight soak (src/overnight.mjs) detached: survives the terminal
# closing (nohup) and keeps the Mac from idle-sleeping (caffeinate -i; -s also
# blocks system sleep while on AC power). Needs the collector stack running:
#   docker compose -f docker/docker-compose.yml up -d --build
# and the built SDK: pnpm --filter @theirside/sdk build
#
#   tools/soak/overnight.sh [--hours 8] [any other overnight.mjs option]
#
# Results: tools/soak/results/<date>/ (git-ignored). Stop early: kill <orchestrator pid>
# (in pids.json there); SUMMARY.md is still written for what ran.
set -euo pipefail
cd "$(dirname "$0")"
dir="results/$(date +%Y-%m-%d)"
[ -e "$dir" ] && dir="results/$(date +%Y-%m-%d-%H%M)"
mkdir -p "$dir"
nohup caffeinate -i -s node src/overnight.mjs --out-dir "$dir" "$@" > "$dir/overnight.log" 2>&1 &
echo "started: pid $! (caffeinate; node overnight.mjs runs under it)"
echo "log:     $(pwd)/$dir/overnight.log"
echo "summary: $(pwd)/$dir/SUMMARY.md (when it finishes)"
