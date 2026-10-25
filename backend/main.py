"""FastAPI backend for the browser-based CEE application.

Supabase Auth, Realtime and Storage remain client-side to preserve existing
features. Backend queries forward the *user's* JWT, not an elevated service
role, so the original Supabase Row Level Security policies still apply.
"""

from __future__ import annotations

import os
import re
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent


def read_public_config(path: Path = ROOT / "config.js") -> tuple[str, str]:
    """Use the existing public Supabase URL and anon key, never a service key."""
    source = path.read_text(encoding="utf-8")

    def read(name: str) -> str:
        match = re.search(
            rf"\bexport\s+const\s+{name}\s*=\s*(['\"])(.*?)\1\s*;?",
            source,
        )
        if not match or not match.group(2):
            raise RuntimeError(f"Missing {name} in config.js")
        return match.group(2)

    url = read("SUPABASE_URL").rstrip("/")
    key = read("SUPABASE_ANON_KEY")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeError("SUPABASE_URL must be a valid HTTPS origin")
    if parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError("SUPABASE_URL must contain only the origin")
    return url, key


SUPABASE_URL, SUPABASE_ANON_KEY = read_public_config()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(timeout=12.0, follow_redirects=False) as client:
        app.state.http = client
        yield


app = FastAPI(title="CEE API", version="2.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)


class Street(BaseModel):
    id: int
    name: str
    neighborhood: list[str]


class NumberingRule(BaseModel):
    id: int
    start_number: int | None
    end_number: int | None
    side: str
    description: str | None


class ZipBreakdown(BaseModel):
    id: int
    zip_code: str
    numbering_rules: list[NumberingRule]


async def require_jwt(authorization: Annotated[str | None, Header()] = None) -> str:
    if not authorization or not re.fullmatch(r"Bearer [A-Za-z0-9_=.\-]+", authorization):
        raise HTTPException(status_code=401, detail="Sessão necessária.")
    token = authorization[7:]
    try:
        response = await app.state.http.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Falha ao validar sessão.") from exc
    if response.status_code != 200 or not response.json().get("id"):
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada.")
    return token


async def read_postgrest(table: str, params: dict[str, str | int], token: str) -> list[dict]:
    # The table argument is server controlled, never taken directly from the user.
    try:
        response = await app.state.http.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            params=params,
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, list):
            raise ValueError("Unexpected upstream payload")
        return data
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Consulta ao Supabase indisponível.") from exc


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def search_pattern(term: str) -> str:
    ascii_term = unicodedata.normalize("NFD", term.strip().lower())
    ascii_term = "".join(c for c in ascii_term if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", "%", ascii_term)


def zip_pattern(term: str) -> str:
    digits = re.sub(r"\D", "", term)
    if not digits:
        return ""
    if not digits.startswith("880"):
        digits = "880" + digits
    digits = digits[:8]
    if len(digits) > 5:
        return digits[:5] + "-" + digits[5:]
    return digits


@app.get("/api/streets/search", response_model=list[Street])
async def find_streets(
    term: Annotated[str, Query(min_length=1, max_length=160)],
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
    token: str = Depends(require_jwt),
):
    if not term.strip():
        return []
    normalized = search_pattern(term)
    ids: list[int] = []
    if re.search(r"\d", term):
        zipcode = zip_pattern(term)
        matched = await read_postgrest(
            "zip_codes",
            {"select": "street_id", "zip_code": f"ilike.*{zipcode}*", "limit": limit},
            token,
        )
        ids = [int(row["street_id"]) for row in matched]
    params: dict[str, str | int] = {
        "select": "id,name,neighborhood", "order": "name.asc", "limit": limit
    }
    if ids:
        params["or"] = f"(search_text.ilike.*{normalized}*,id.in.({','.join(map(str, ids))}))"
    else:
        params["search_text"] = f"ilike.*{normalized}*"
    return await read_postgrest("streets", params, token)


@app.get("/api/streets/{street_id}/zips", response_model=list[ZipBreakdown])
async def street_zips(street_id: int, token: str = Depends(require_jwt)):
    if street_id < 1:
        raise HTTPException(status_code=422, detail="Invalid street ID")
    return await read_postgrest(
        "zip_codes",
        {
            "select": "id,zip_code,numbering_rules(id,start_number,end_number,side,description)",
            "street_id": f"eq.{street_id}",
            "order": "zip_code.asc",
        },
        token,
    )


@app.api_route("/api/db/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"])
async def proxy_postgrest(request: Request, path: str, token: str = Depends(require_jwt)):
    """Forward authenticated database CRUD/RPC calls without bypassing RLS.

    Supabase Auth, Realtime and Storage do not use this route. All proxy
    destinations are fixed under our own Supabase PostgREST origin.
    """
    if not re.fullmatch(r"(?:[a-zA-Z_][a-zA-Z_0-9]*|rpc/[a-zA-Z_][a-zA-Z_0-9]*)", path):
        raise HTTPException(status_code=404, detail="Invalid database endpoint")

    forward_headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {token}",
    }
    for name in ("accept", "content-type", "prefer", "range", "range-unit", "accept-profile", "content-profile"):
        if name in request.headers:
            forward_headers[name] = request.headers[name]

    try:
        upstream = await app.state.http.request(
            method=request.method,
            url=f"{SUPABASE_URL}/rest/v1/{path}",
            params=request.query_params.multi_items(),
            headers=forward_headers,
            content=await request.body(),
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Supabase temporariamente indisponível.") from exc
    exposed_headers = {}
    for name in ("content-type", "content-range", "preference-applied"):
        if name in upstream.headers:
            exposed_headers[name] = upstream.headers[name]
    return Response(content=upstream.content, status_code=upstream.status_code, headers=exposed_headers)


# Vite builds index.html and all assets to dist/. The API routes take priority.
DIST = ROOT / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
