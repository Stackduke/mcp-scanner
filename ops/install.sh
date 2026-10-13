#!/usr/bin/env bash
# Installs the daily scan for the current user, runs it once, and shows the result.
# Run it yourself: it sets up something that keeps running and uses your GitHub login.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.local/bin" "$HOME/.local/state" "$HOME/.config/systemd/user"
install -m 755 "$here/aethis-mcp-scan" "$HOME/.local/bin/aethis-mcp-scan"
cp "$here/aethis-mcp-scan.service" "$here/aethis-mcp-scan.timer" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now aethis-mcp-scan.timer
systemctl --user start aethis-mcp-scan.service || true
echo "Last log line:"; tail -n 1 "$HOME/.local/state/aethis-mcp-scan.log"
systemctl --user list-timers aethis-mcp-scan.timer --no-pager | head -n 2
