"""
db.py — domain-agnostic read-only SQLite access layer.

Blueprint note: this module has no idea what "Schwab" or "trades" means.
Porting to another project (e.g. Leo) means pointing SOURCE_DB_PATH at a
different file — nothing else in this module changes.

Two layers of read-only enforcement, deliberately redundant:
  1. assert_read_only() rejects anything that isn't a single SELECT/WITH
     statement before it ever reaches SQLite.
  2. The connection itself is opened with the `mode=ro` URI flag, so even if
     something slipped past (1), SQLite refuses the write at the VFS layer
     ("attempt to write a readonly database").
"""
import os
import re
import sqlite3
from pathlib import Path
from urllib.parse import quote

import aiosqlite

DB_PATH = os.environ.get(
    "SOURCE_DB_PATH", str(Path(__file__).resolve().parent.parent / "data" / "trades.db")
)

_DISALLOWED_KEYWORDS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|"
    r"PRAGMA|VACUUM|REINDEX|TRIGGER|GRANT|REVOKE)\b",
    re.IGNORECASE,
)
_LEADING_KEYWORD = re.compile(r"^(SELECT|WITH)\b", re.IGNORECASE)


class QueryRejected(ValueError):
    """Raised when a submitted query fails the read-only SQL guard."""


def assert_read_only(sql: str) -> str:
    """
    Validate that `sql` is a single read-only SELECT (or WITH ... SELECT)
    statement. Returns the trimmed statement on success.
    """
    stmt = sql.strip()
    if not stmt:
        raise QueryRejected("Empty query.")

    # Allow one optional trailing semicolon, but reject anything that looks
    # like a second stacked statement after it.
    body = stmt[:-1].strip() if stmt.endswith(";") else stmt
    if ";" in body:
        raise QueryRejected("Multiple statements are not allowed.")

    if not _LEADING_KEYWORD.match(body):
        raise QueryRejected("Only SELECT (or WITH ... SELECT) statements are allowed.")

    if _DISALLOWED_KEYWORDS.search(body):
        raise QueryRejected("Query contains a disallowed keyword.")

    return body


def _ro_uri(path: str) -> str:
    return f"file:{quote(os.path.abspath(path))}?mode=ro"


async def get_ro_connection() -> aiosqlite.Connection:
    """
    Open a fresh, per-request read-only connection to the source DB.

    A busy_timeout is set because the source DB may have a concurrent writer
    using rollback-journal (DELETE) mode rather than WAL — see README notes
    on concurrent-read edge cases. Per-request connections (no pooling) keep
    this simple and avoid holding locks between requests; fine at the
    request volumes a local agent bridge sees.
    """
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Source database not found at {DB_PATH}")
    conn = await aiosqlite.connect(_ro_uri(DB_PATH), uri=True)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def source_db_accessible() -> bool:
    """Cheap sync liveness check for /health."""
    if not os.path.exists(DB_PATH):
        return False
    try:
        conn = sqlite3.connect(_ro_uri(DB_PATH), uri=True)
        try:
            conn.execute("SELECT 1")
        finally:
            conn.close()
        return True
    except sqlite3.Error:
        return False
