#!/usr/bin/env bash
set -euo pipefail

# Encrypted, multi-disk backup of local/data/trades.db — the actual durability
# fix for Schwab's export window: once a fill is synced by sync-schwab.js it
# lives in this file forever regardless of broker retention, but only if the
# file itself survives hardware failure. Per explicit user requirement, this
# keeps a copy on all three physical disks on this machine (confirmed via
# lsblk, not assumed):
#   - source:  Samsung SSD 850  (sdb, /media/osaenz/2ndsk1) — the live file
#   - copy A:  Hitachi HDS72101 (sda, /mnt/Dev)             — different disk
#   - copy B:  Micron 2300 NVMe (nvme0n1, backs /)          — different disk
# A single disk failure — including the one the live app runs on — still
# leaves the data recoverable from either of the other two.

DB_FILE="/media/osaenz/2ndsk1/github/TG-Capital/local/data/trades.db"
BACKUP_DIRS=(
  "/mnt/Dev/backups/tg-capital"           # sda  — Hitachi HDS72101
  "$HOME/backups/tg-capital"              # nvme — Micron 2300 (backs root /)
)
PASSPHRASE_FILE="$HOME/.config/tg-capital-backup/passphrase"
RETENTION_DAYS=30

if [ ! -f "$PASSPHRASE_FILE" ]; then
  echo "Missing passphrase file at $PASSPHRASE_FILE — run setup first." >&2
  exit 1
fi
if [ ! -f "$DB_FILE" ]; then
  echo "trades.db not found at $DB_FILE — nothing to back up." >&2
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT="/tmp/trades-backup-$TIMESTAMP.db"
ENCRYPTED_NAME="trades-$TIMESTAMP.db.gpg"
ENCRYPTED_TMP="/tmp/$ENCRYPTED_NAME"

# sqlite3's own .backup command, not cp — takes a transactionally-consistent
# snapshot even if the server is mid-write, unlike a raw file copy which can
# grab a torn/partial page and produce a corrupt backup. Encrypted once, then
# copied to every disk — no reason to re-encrypt per destination.
sqlite3 "$DB_FILE" ".backup '$SNAPSHOT'"
gpg --batch --yes --passphrase-file "$PASSPHRASE_FILE" \
    --symmetric --cipher-algo AES256 \
    --output "$ENCRYPTED_TMP" "$SNAPSHOT"
rm -f "$SNAPSHOT"

FAILED=0
for DIR in "${BACKUP_DIRS[@]}"; do
  mkdir -p "$DIR"
  if cp "$ENCRYPTED_TMP" "$DIR/$ENCRYPTED_NAME"; then
    find "$DIR" -name 'trades-*.db.gpg' -mtime +"$RETENTION_DAYS" -delete
    echo "$(date -Iseconds) backup OK on $DIR: $ENCRYPTED_NAME ($(du -h "$DIR/$ENCRYPTED_NAME" | cut -f1))"
  else
    echo "$(date -Iseconds) backup FAILED on $DIR" >&2
    FAILED=1
  fi
done

rm -f "$ENCRYPTED_TMP"
exit "$FAILED"
