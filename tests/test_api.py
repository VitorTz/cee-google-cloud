"""API regression checks; no real Correios/Supabase data is contacted."""

import httpx
from fastapi.testclient import TestClient

from backend.main import app, read_public_config, search_pattern, zip_pattern


def test_config_reads_existing_file():
    url, key = read_public_config()
    assert url.startswith("https://")
    assert key  # The existing key is a public 'anon' key, not a service role.


def test_search_normalization():
    assert search_pattern("Rua São José") == "rua%sao%jose"
    assert zip_pattern("47-401") == "88047-401"
    assert zip_pattern("88047-401") == "88047-401"


def test_authentication_and_rls_forwarding():
    requests = []

    def route(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["authorization"] == "Bearer signed-user-jwt"
        if request.url.path == "/auth/v1/user":
            return httpx.Response(200, json={"id": "user-id"})
        if request.url.path == "/rest/v1/streets":
            assert request.url.params["select"] == "id,name,neighborhood"
            assert request.url.params["search_text"] == "ilike.*rua%sao*"
            return httpx.Response(200, json=[{"id": 1, "name": "Rua São", "neighborhood": ["Centro"]}])
        if request.url.path == "/rest/v1/zip_codes":
            assert request.url.params["street_id"] == "eq.1"
            return httpx.Response(200, json=[{"id": 2, "zip_code": "88047-401", "numbering_rules": []}])
        raise AssertionError(f"Unexpected HTTP request: {request.url}")

    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/api/streets/search?term=Rua").status_code == 401
        original = app.state.http
        app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(route))
        try:
            headers = {"Authorization": "Bearer signed-user-jwt"}
            response = client.get("/api/streets/search?term=Rua%20S%C3%A3o", headers=headers)
            assert response.status_code == 200, response.text
            assert response.json()[0]["name"] == "Rua São"
            response = client.get("/api/streets/1/zips", headers=headers)
            assert response.status_code == 200, response.text
            assert response.json()[0]["zip_code"] == "88047-401"
            assert len(requests) == 4
        finally:
            app.state.http = original


def test_reject_invalid_token():
    def route(request: httpx.Request):
        assert request.url.path == "/auth/v1/user"
        return httpx.Response(401, json={"message": "invalid JWT"})

    with TestClient(app) as client:
        original = app.state.http
        app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(route))
        try:
            response = client.get("/api/streets/search?term=Rua", headers={"Authorization": "Bearer wrong"})
            assert response.status_code == 401
        finally:
            app.state.http = original


def test_input_validation():
    with TestClient(app) as client:
        # Authentication happens first, so unauthenticated invalid queries yield 401.
        assert client.get("/api/streets/search?term=Rua&limit=100").status_code == 401
        assert client.get("/api/streets/search?term=").status_code == 401


def test_authenticated_postgrest_proxy_propagates_rls_and_method():
    calls = []

    def route(request: httpx.Request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer signed-user-jwt"
        if request.url.path == "/auth/v1/user":
            return httpx.Response(200, json={"id": "user-id"})
        assert request.url.path == "/rest/v1/daily_truck_arrivals"
        assert request.method == "POST"
        assert request.headers["prefer"] == "return=minimal"
        assert request.url.params["select"] == "*"
        assert request.content == b'{"cdl_count":1}'
        return httpx.Response(201, headers={"Content-Type": "application/json"}, json={})

    with TestClient(app) as client:
        original = app.state.http
        app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(route))
        try:
            response = client.post(
                "/api/db/daily_truck_arrivals?select=*",
                headers={"Authorization": "Bearer signed-user-jwt", "Prefer": "return=minimal"},
                json={"cdl_count": 1},
            )
            assert response.status_code == 201
            assert len(calls) == 2
            invalid = client.get("/api/db/../../auth/v1/user", headers={"Authorization": "Bearer signed-user-jwt"})
            assert invalid.status_code in (404, 405)
        finally:
            app.state.http = original


def test_proxy_keeps_supabase_rls_denials():
    def route(request: httpx.Request):
        if request.url.path == "/auth/v1/user":
            return httpx.Response(200, json={"id": "user-id"})
        assert request.url.path == "/rest/v1/employees"
        return httpx.Response(403, json={"code": "42501", "message": "permission denied"})

    with TestClient(app) as client:
        original = app.state.http
        app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(route))
        try:
            response = client.get("/api/db/employees?select=*", headers={"Authorization": "Bearer signed-user-jwt"})
            assert response.status_code == 403
            assert response.json()["code"] == "42501"
        finally:
            app.state.http = original
