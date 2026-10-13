# EasyCFD OpenFOAM server

Run advanced OpenFOAM simulations on your own computer and connect the static
[EasyCFD frontend](https://easy-cfd.mthracelab.com/) to it. The published image is
[`markthebault/easy-cfd-backend`](https://hub.docker.com/r/markthebault/easy-cfd-backend).
It supports Linux AMD64 and ARM64, including Docker Desktop on Apple Silicon.

## Start with Docker

Start Docker, then copy this block into a macOS or Linux terminal. No repository
checkout, Python install or local image build is required.

```sh
docker run -it --rm --pull=always --name easycfd-openfoam --init \
  -p 127.0.0.1:8000:8000 \
  -v "$HOME/easycfd-data:/data" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e EASYCFD_HOST_DATA="$HOME/easycfd-data" \
  markthebault/easy-cfd-backend:latest
```

In EasyCFD, open **Run → OpenFOAM server connection**. Paste the
`http://localhost:8000?token=…` URL printed in the terminal and connect. Allow local
network access if the browser asks. Select **OpenFOAM · Server** to run advanced
analysis. Browser Quick, Fast and Detailed runs continue to work independently.

The backend image contains the API, geometry preparation and persistent queue.
It launches the pinned OpenCFD v2412 solver in separate Docker containers;
it downloads that solver automatically on first startup and reuses it afterward.
Docker creates the data folder automatically. The first startup can take a few
minutes; download progress appears in the terminal. Keep Docker running.
The backend uses your Docker daemon, so run it on a computer you trust.

Projects, runs and the generated connection token stay in `~/easycfd-data`.
Keep the terminal open while using the server. After active runs finish, press
**Ctrl+C** to stop it. Docker removes the container automatically; the host data
directory and token remain. Paste the startup block again to restart the server.

## Update

Finish active runs first and press **Ctrl+C**, then run the startup command again.
Its `--pull=always` option checks for the latest server image automatically.
The data directory and connection token are kept. Use the `sha-COMMIT` tag instead of `latest` to
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
