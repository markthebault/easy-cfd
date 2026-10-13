# EasyCFD OpenFOAM server

Run advanced OpenFOAM simulations on your own computer and connect the static
[EasyCFD frontend](https://easy-cfd.mthracelab.com/) to it. The published image is
[`markthebault/easy-cfd-backend`](https://hub.docker.com/r/markthebault/easy-cfd-backend).
It supports Linux AMD64 and ARM64, including Docker Desktop on Apple Silicon.

## Start with Docker

Start Docker, then copy this block into a macOS or Linux terminal. No repository
checkout, Python install or local image build is required.

```sh
mkdir -p "$HOME/easycfd-data"
docker pull opencfd/openfoam-default@sha256:1ba02114b1c025c370f2e269a07677c16c9bea8d990fcd75ac8378aff9d41b50
docker run -d --name easycfd-openfoam --init --restart unless-stopped \
  -p 127.0.0.1:8000:8000 \
  -v "$HOME/easycfd-data:/data" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e EASYCFD_HOST_DATA="$HOME/easycfd-data" \
  markthebault/easy-cfd-backend:latest
docker logs easycfd-openfoam
```

In EasyCFD, open **Run → OpenFOAM server connection**. Paste the
`http://localhost:8000?token=…` URL printed in the logs and connect. Allow local
network access if the browser asks. Select **OpenFOAM · Server** to run advanced
analysis. Browser Quick, Fast and Detailed runs continue to work independently.

The backend image contains the API, geometry preparation and persistent queue.
It launches the pinned OpenCFD v2412 solver in separate Docker containers;
that solver image is downloaded by the first command. Keep Docker running.
The backend uses your Docker daemon, so run it on a computer you trust.

Projects, runs and the generated connection token stay in `~/easycfd-data`.
They survive container restarts and replacement. Start the container once;
afterward use:

```sh
docker stop easycfd-openfoam
docker start easycfd-openfoam
```

## Update

Finish active runs first, then download the latest image and recreate the API
container. The data directory and connection token are kept.

```sh
docker pull markthebault/easy-cfd-backend:latest
docker stop easycfd-openfoam
docker rm easycfd-openfoam
```

Run the startup block again. Use the `sha-COMMIT` tag instead of `latest` to
select a source revision. Pin the full image digest (`@sha256:…`) when you need
the exact published image.

## Another computer or port

For a server on another computer, expose port 8000 through HTTPS, such as a
reverse proxy or Tailscale Serve. Paste its HTTPS address with the same
`?token=…` value into EasyCFD. The default Docker port binding accepts local
connections; a proxy on that computer can forward them.

Add `-e EASYCFD_PUBLIC_URL=https://your-server.example` to the Docker run command
to print the correct remote address in the startup logs. This advertises the
address; it does not set up HTTPS or create a tunnel.

To use another local port, change the binding to `127.0.0.1:8001:8000` and add
`-e EASYCFD_PUBLIC_URL=http://localhost:8001`. Optional settings include
`EASYCFD_PROCESSES` (4 by default), `EASYCFD_API_TOKEN`, and
`EASYCFD_CORS_ORIGINS`. The data path must be absolute and identify the same
directory on the Docker daemon's host; it is shared by the API and solver.

## Automatic publishing

[The Docker backend workflow](../.github/workflows/docker-backend.yml) builds
and tests both architectures on native GitHub runners. Pull requests only build
and test. Every push to `main` publishes the exact tested images and joins their
digests under `latest`, `main`, and `sha-FULL_COMMIT` tags once the workflow is
merged to `main`. A manual run on `main`
can rebuild a release; a manual run on another branch only tests it.

GitHub repository settings contain the `DOCKERHUB_USERNAME` variable and
`DOCKERHUB_TOKEN` secret. Rotate that secret when the Docker Hub publishing token
changes. Registry credentials are used only by main-branch publishing steps.
The frontend's Cloudflare build remains separate and needs no Docker credentials.
