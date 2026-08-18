#!/usr/bin/env bash
set -euo pipefail

# Analytical SQL layer over trades.db via DuckDB's sqlite_scanner — read-only,
# zero migration, zero duplication, always current (queries the live file
# directly, not a copy). This is the "own your data, query it any way you
# want" piece: real window functions, fast aggregation over years of fills,
# without touching the app's actual data layer (server.js keeps using
# better-sqlite3 exactly as before — this is a separate, additive lens on the
# same file, not a replacement for it).
#
# Scope note: this only sees raw trades (one row per fill/leg). It does NOT
# replicate positionEngine.js's roll-aware chain logic or FIFO equity lot
# matching — for actual position-level P&L (rolls collapsed into one logical
# trade, etc.) use the app's own dashboard/API, which gets that right. Use
# this for fill-level and time-series analytics: P&L by symbol/month/year,
# fee drag, trade counts, whatever ad-hoc slicing you want.
#
# Usage: duckdb-trades.sh              interactive SQL prompt
#        duckdb-trades.sh "SELECT ..."  run one query and exit

DB_FILE="/media/osaenz/2ndsk1/github/TG-Capital/local/data/trades.db"
DUCKDB="$HOME/.local/bin/duckdb"

INIT_SQL="
INSTALL sqlite;
LOAD sqlite;
ATTACH '$DB_FILE' AS trades_db (TYPE sqlite, READ_ONLY);
USE trades_db;
"

if [ $# -eq 0 ]; then
  "$DUCKDB" -cmd "$INIT_SQL"
else
  "$DUCKDB" -c "$INIT_SQL $1"
fi
