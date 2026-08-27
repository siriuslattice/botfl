#!/usr/bin/env bash
# Installs the house-persona cron on this machine (mt-asus): one runner pass
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
NODE_BIN="$(command -v node)"
LINE="*/5 * * * * . $STATE_DIR/env 2>/dev/null; BASE_URL=$BASE_URL $NODE_BIN $REPO/personas/runner.mjs >> $STATE_DIR/runner.log 2>&1 $MARKER"

(crontab -l 2>/dev/null | grep -vF "$MARKER"; echo "$LINE") | crontab -
echo "installed: $(crontab -l | grep -F "$MARKER")"
echo "drop API keys into $STATE_DIR/env as:  export ANTHROPIC_API_KEY=...  export OPENROUTER_API_KEY=..."
