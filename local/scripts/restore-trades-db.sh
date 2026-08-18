#!/usr/bin/env bash
set -euo pipefail

# Decrypts a backup made by backup-trades-db.sh and verifies it's a valid,
# uncorrupted SQLite database before declaring success — an encrypted backup
# that turns out to be unreadable when you actually need it is worse than no
# backup (false confidence), so this always runs PRAGMA integrity_check
# rather than just trusting the decrypt succeeded.
#
# Usage: restore-trades-db.sh <backup-file.db.gpg> [output-path]

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup-file.db.gpg> [output-path]" >&2
  exit 1
fi

ENCRYPTED="$1"
OUTPUT="${2:-./trades-restored.db}"
PASSPHRASE_FILE="$HOME/.config/tg-capital-backup/passphrase"

if [ ! -f "$PASSPHRASE_FILE" ]; then
  echo "Missing passphrase file at $PASSPHRASE_FILE" >&2
  exit 1
fi
if [ ! -f "$ENCRYPTED" ]; then
  echo "Backup file not found: $ENCRYPTED" >&2
  exit 1
fi

gpg --batch --yes --passphrase-file "$PASSPHRASE_FILE" --decrypt "$ENCRYPTED" > "$OUTPUT" 2>/dev/null

RESULT=$(sqlite3 "$OUTPUT" "PRAGMA integrity_check;")
if [ "$RESULT" != "ok" ]; then
  echo "INTEGRITY CHECK FAILED: $RESULT" >&2
  exit 1
fi

echo "Restored and verified OK: $OUTPUT ($(sqlite3 "$OUTPUT" "SELECT COUNT(*) FROM trades;") trade rows)"
