# The API owns the queue and starts the pinned OpenFOAM solver as sibling containers.
FROM docker:29-cli AS docker-cli
FROM ghcr.io/astral-sh/uv:0.9.5 AS uv
FROM python:3.13-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libgomp1 libxrender1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY backend ./backend
RUN uv sync --locked --no-dev --no-editable && uv cache clean

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="EasyCFD OpenFOAM backend" \
    org.opencontainers.image.description="Token-protected EasyCFD API and persistent OpenFOAM job queue" \
    org.opencontainers.image.source="https://github.com/markthebault/easy-cfd" \
    org.opencontainers.image.revision=$VCS_REF

ENV PATH="/app/.venv/bin:$PATH" EASYCFD_DATA=/data EASYCFD_REMOTE=true PYTHONUNBUFFERED=1
EXPOSE 8000
# Single worker owns the persistent queue. Avoid query-string tokens in access logs.
CMD ["uvicorn", "easycfd.api:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
