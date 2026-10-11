"""Local access by default; explicitly enabled remote API access requires a bearer token."""

import os
import secrets
import logging
from urllib.parse import quote, urlparse, urlsplit, urlunsplit

from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request

from . import storage


def connection_url(base_url, token):
    """The URL users paste into the frontend, with an encoded token."""
    parsed = urlsplit(base_url.strip())
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if not parsed.hostname or (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)):
        raise ValueError("EASYCFD_PUBLIC_URL must use HTTPS, or HTTP for localhost.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("EASYCFD_PUBLIC_URL must not contain credentials, a query or a fragment.")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "token=" + quote(token, safe=""), ""))


class AccessMiddleware:
    def __init__(self, app):
        self.app = app
        self.remote = os.environ.get("EASYCFD_REMOTE", "false").lower() == "true"
        self.token = ""
        if self.remote:
            self.token = os.environ.get("EASYCFD_API_TOKEN", "").strip()
            if not self.token:
                token_file = storage.ROOT / ".api-token"
                token_file.parent.mkdir(parents=True, exist_ok=True)
                try:
                    fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    self.token = token_file.read_text().strip()
                else:
                    self.token = secrets.token_urlsafe(32)
                    with os.fdopen(fd, "w") as stream:
                        stream.write(self.token + "\n")
                if not self.token:
                    raise ValueError(f"Empty API token file: {token_file}")
            origins_setting = os.environ.get("EASYCFD_CORS_ORIGINS", "").strip() or "*"
            origins = [x.strip().rstrip("/") for x in origins_setting.split(",") if x.strip()]
            self.application = CORSMiddleware(
                self.authorized,
                allow_origins=origins,
                allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
                allow_headers=["Authorization", "Content-Type", "ngrok-skip-browser-warning"],
                allow_credentials=False,
            )
            url = connection_url(os.environ.get("EASYCFD_PUBLIC_URL", "").strip() or "http://localhost:8000", self.token)
            logging.getLogger("uvicorn.error").info(
                "\nEasyCFD OpenFOAM backend\n"
                "Paste this URL into the frontend's OpenFOAM server connection:\n"
                "  %s\n"
                "CORS frontend origins: %s\n"
                "Backend hostnames: any (API token required)",
                url, ", ".join(origins),
            )
        else:
            self.application = self.authorized

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        await self.application(scope, receive, send)

    async def authorized(self, scope, receive, send):
        request = Request(scope)
        if self.remote:
            # This mode exposes only the API, including every binary asset and mutating endpoint.
            if not (request.url.path == "/api" or request.url.path.startswith("/api/")):
                response = JSONResponse({"detail": "Remote mode exposes the API only."}, status_code=404)
                return await response(scope, receive, send)
            authorization = request.headers.get("authorization", "")
            scheme, _, bearer = authorization.partition(" ")
            supplied = bearer if scheme.lower() == "bearer" else request.query_params.get("token", "")
            if not secrets.compare_digest(supplied.encode(), self.token.encode()):
                response = JSONResponse(
                    {"detail": "Invalid or missing OpenFOAM API token."}, status_code=401,
                    headers={"WWW-Authenticate": "Bearer", "Cache-Control": "no-store"},
                )
                return await response(scope, receive, send)
        else:
            tailnet_origin = os.environ.get("EASYCFD_TAILNET_ORIGIN", "").rstrip("/")
            host = urlparse("//" + request.headers.get("host", "")).hostname
            allowed_hosts = {"localhost", "127.0.0.1", "::1", "testserver"}
            if tailnet_origin:
                allowed_hosts.add(urlparse(tailnet_origin).hostname)
            if host not in allowed_hosts:
                response = JSONResponse({"detail": "This application accepts local connections only."}, status_code=403)
                return await response(scope, receive, send)
            origin = request.headers.get("origin")
            if origin and origin != tailnet_origin and urlparse(origin).hostname not in ("localhost", "127.0.0.1", "::1"):
                response = JSONResponse({"detail": "External origins are not allowed."}, status_code=403)
                return await response(scope, receive, send)
        await self.app(scope, receive, send)
