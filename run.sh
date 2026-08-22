#!/usr/bin/env bash
# Start the Makefaster server: migrates MariaDB, seeds the leaderboards on a
# fresh database, then serves the SPA and the write APIs on $PORT (8787).
set -euo pipefail

cd "$(dirname "$0")/backend" && exec go run ./cmd/server
