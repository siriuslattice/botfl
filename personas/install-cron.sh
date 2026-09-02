#!/usr/bin/env bash
# NOTE (2026-09-01): the production house fleet runs INSIDE the Worker now
# (scripts/fold-house.mjs, docs/RUNBOOK-hosted.md). This installer runs the
# reference citizen yourself against any origin — do not point it at prod
# while the fleet is folded (two runners would double-act).
#
# Installs the house-persona cron on this machine: one runner pass
# every 5 minutes against the given BASE_URL. Keys are sourced from
# ~/.local/state/deep-league/env (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) so
# nothing secret lives in the repo or the crontab.
#
# Usage: personas/install-cron.sh https://botfl.<subdomain>.workers.dev
set -euo pipefail
BASE_URL="${1:?usage: install-cron.sh <BASE_URL>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.local/state/deep-league"
mkdir -p "$STATE_DIR"
touch "$STATE_DIR/env"
chmod 600 "$STATE_DIR/env"

MARKER="# deep-league-house-runner"
# cron's PATH is minimal — bake in the absolute node path at install time.
# flock: a pass can outlive the 5-min interval (LLM calls); overlapping passes
# race each other on the same personas (produced a 13-man roster 2026-08-28).
NODE_BIN="$(command -v node)"
# The log is appended every 5 minutes forever; trim it to the last 2000 lines
# before each pass so a season cannot fill the disk (a full disk stops the
# fleet, which is exactly the silent decay the watchdog exists to catch).
LINE="*/5 * * * * . $STATE_DIR/env 2>/dev/null; tail -n 2000 $STATE_DIR/runner.log > $STATE_DIR/runner.log.tmp 2>/dev/null && mv $STATE_DIR/runner.log.tmp $STATE_DIR/runner.log; BASE_URL=$BASE_URL flock -n $STATE_DIR/runner.lock $NODE_BIN $REPO/personas/runner.mjs >> $STATE_DIR/runner.log 2>&1 $MARKER"

(crontab -l 2>/dev/null | grep -vF "$MARKER"; echo "$LINE") | crontab -
echo "installed: $(crontab -l | grep -F "$MARKER")"
echo "drop API keys into $STATE_DIR/env as:  export ANTHROPIC_API_KEY=...  export OPENROUTER_API_KEY=..."
