"""
vault.py — domain-agnostic query vault: a read-write log of validated
human-intent -> SQL mappings, plus fuzzy intent matching.

Blueprint note: nothing here is Schwab-specific. A future port (e.g. Leo)
can point VAULT_DB_PATH at its own file or just leave the default — each
port gets its own independent vault.db.
"""
import os
import sqlite3
import difflib
from pathlib import Path
from datetime import datetime, timezone

import aiosqlite

VAULT_DB_PATH = os.environ.get("VAULT_DB_PATH", str(Path(__file__).resolve().parent / "vault.db"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS query_vault (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    intent        TEXT NOT NULL,
    sql_query     TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_used     TEXT,
    success_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_vault_intent ON query_vault(intent);
"""


def init_vault_db() -> None:
    """Create vault.db and its schema if missing. Call once at app startup."""
    conn = sqlite3.connect(VAULT_DB_PATH)
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def vault_db_accessible() -> bool:
    try:
        conn = sqlite3.connect(VAULT_DB_PATH)
        try:
            conn.execute("SELECT 1")
        finally:
            conn.close()
        return True
    except sqlite3.Error:
        return False


async def record_success(intent: str, sql_query: str) -> None:
    """
    Upsert on exact (case-sensitive) intent match: bump success_count and
    refresh last_used/sql_query if it exists, else insert a new row.
    """
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(VAULT_DB_PATH) as conn:
        cur = await conn.execute("SELECT id FROM query_vault WHERE intent = ?", (intent,))
        row = await cur.fetchone()
        if row:
            await conn.execute(
                "UPDATE query_vault SET success_count = success_count + 1, "
                "last_used = ?, sql_query = ? WHERE id = ?",
                (now, sql_query, row[0]),
            )
        else:
            await conn.execute(
                "INSERT INTO query_vault (intent, sql_query, last_used) VALUES (?, ?, ?)",
                (intent, sql_query, now),
            )
        await conn.commit()


async def list_entries(limit: int = 50, offset: int = 0) -> list[dict]:
    async with aiosqlite.connect(VAULT_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute(
            "SELECT * FROM query_vault ORDER BY success_count DESC, last_used DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        return [dict(r) for r in await cur.fetchall()]


async def count_entries() -> int:
    async with aiosqlite.connect(VAULT_DB_PATH) as conn:
        cur = await conn.execute("SELECT COUNT(*) FROM query_vault")
        (n,) = await cur.fetchone()
        return n


async def match_intent(intent: str, threshold: float = 0.35, top_n: int = 1) -> list[dict]:
    """
    Fuzzy-match `intent` against stored intents using difflib.SequenceMatcher
    (stdlib — no external deps, more useful than plain LIKE for this size).
    Loads the whole vault; fine at hundreds of distinct intents. If this
    grows into the thousands, pre-filter with a LIKE on shared tokens first.
    """
    async with aiosqlite.connect(VAULT_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("SELECT * FROM query_vault")
        rows = [dict(r) for r in await cur.fetchall()]

    needle = intent.lower().strip()
    scored = [
        (difflib.SequenceMatcher(None, needle, row["intent"].lower()).ratio(), row)
        for row in rows
    ]
    scored = [(score, row) for score, row in scored if score >= threshold]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [{**row, "match_score": round(score, 3)} for score, row in scored[:top_n]]


async def delete_entry(entry_id: int) -> bool:
    async with aiosqlite.connect(VAULT_DB_PATH) as conn:
        cur = await conn.execute("DELETE FROM query_vault WHERE id = ?", (entry_id,))
        await conn.commit()
        return cur.rowcount > 0
