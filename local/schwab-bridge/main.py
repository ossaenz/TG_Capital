"""
main.py — read-only SQLite <-> AI-agent HTTP bridge (blueprint).

Two databases, two trust levels:
  - db.DB_PATH        — read-only source data (Schwab trades.db). Never written to.
  - vault.VAULT_DB_PATH — read-write query vault owned entirely by this service.

Auth: none. This assumes the AI agent calls in over localhost only. To add
an API key later: give every route `Depends(require_api_key)`, where
require_api_key compares a header (e.g. `X-API-Key`) against an env var
(e.g. BRIDGE_API_KEY) and raises HTTPException(401) on mismatch/missing.
"""
import os
import sqlite3
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

import db
import vault


@asynccontextmanager
async def lifespan(app: FastAPI):
    vault.init_vault_db()
    yield


app = FastAPI(title="SQLite Read-Only Bridge", lifespan=lifespan)


class QueryRequest(BaseModel):
    sql: str
    intent: Optional[str] = Field(
        default=None, description="Human-language description of what this query answers"
    )


class QueryResponse(BaseModel):
    rows: list[dict]
    row_count: int
    sql: str


@app.post("/query", response_model=QueryResponse)
async def run_query(payload: QueryRequest):
    try:
        clean_sql = db.assert_read_only(payload.sql)
    except db.QueryRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        conn = await db.get_ro_connection()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    try:
        cursor = await conn.execute(clean_sql)
        rows = await cursor.fetchall()
        result = [dict(r) for r in rows]
    except sqlite3.Error as exc:
        # Covers "attempt to write a readonly database" (belt-and-suspenders
        # if something ever slipped past assert_read_only) plus ordinary
        # SQL errors — bad column, syntax, etc.
        raise HTTPException(status_code=400, detail=f"Query failed: {exc}")
    finally:
        await conn.close()

    if payload.intent:
        await vault.record_success(payload.intent, clean_sql)

    return QueryResponse(rows=result, row_count=len(result), sql=clean_sql)


@app.get("/vault")
async def get_vault(limit: int = Query(default=50, le=200), offset: int = Query(default=0, ge=0)):
    return {
        "total": await vault.count_entries(),
        "limit": limit,
        "offset": offset,
        "entries": await vault.list_entries(limit=limit, offset=offset),
    }


@app.get("/vault/match")
async def match_vault(intent: str, top_n: int = Query(default=1, le=10)):
    matches = await vault.match_intent(intent, top_n=top_n)
    if not matches:
        raise HTTPException(status_code=404, detail="No sufficiently close match found.")
    return {"query_intent": intent, "matches": matches}


@app.delete("/vault/{entry_id}")
async def remove_vault_entry(entry_id: int):
    deleted = await vault.delete_entry(entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"No vault entry with id={entry_id}")
    return {"deleted": entry_id}


@app.get("/health")
async def health():
    source_ok = db.source_db_accessible()
    vault_ok = vault.vault_db_accessible()
    return {
        "status": "ok" if (source_ok and vault_ok) else "degraded",
        "source_db": {"path": db.DB_PATH, "accessible": source_ok},
        "vault_db": {"path": vault.VAULT_DB_PATH, "accessible": vault_ok},
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.environ.get("BRIDGE_HOST", "127.0.0.1"),
        port=int(os.environ.get("BRIDGE_PORT", "8000")),
    )
