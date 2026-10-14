# The API and pinned OpenFOAM/MPI programs run together without host Docker access.
FROM ghcr.io/astral-sh/uv:0.9.5 AS uv
FROM opencfd/openfoam-default@sha256:1ba02114b1c025c370f2e269a07677c16c9bea8d990fcd75ac8378aff9d41b50

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libgomp1 libxrender1 util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY backend ./backend
RUN uv sync --locked --python /usr/bin/python3 --no-dev --no-editable && uv cache clean

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="EasyCFD OpenFOAM backend" \
    org.opencontainers.image.description="Token-protected EasyCFD API and persistent OpenFOAM job queue" \
    org.opencontainers.image.source="https://github.com/markthebault/easy-cfd" \
    org.opencontainers.image.revision=$VCS_REF

ENV PATH="/app/.venv/bin:$PATH" EASYCFD_DATA=/data EASYCFD_REMOTE=true \
    EASYCFD_SOLVER_MODE=local PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1
EXPOSE 8000
# The inherited entrypoint initializes OpenFOAM, then starts the API with one worker.
CMD ["python", "-m", "easycfd.docker_server"]
