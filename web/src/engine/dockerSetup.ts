export const BACKEND_IMAGE = "markthebault/easy-cfd-backend:latest";
export const SOLVER_IMAGE = "opencfd/openfoam-default@sha256:1ba02114b1c025c370f2e269a07677c16c9bea8d990fcd75ac8378aff9d41b50";

/** Works from any directory on macOS/Linux; matches the backend's sibling-container mounts. */
export const DOCKER_START_COMMAND = `mkdir -p "$HOME/easycfd-data"
docker pull ${SOLVER_IMAGE}
docker run -it --rm --name easycfd-openfoam --init \\
  -p 127.0.0.1:8000:8000 \\
  -v "$HOME/easycfd-data:/data" \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -e EASYCFD_HOST_DATA="$HOME/easycfd-data" \\
  ${BACKEND_IMAGE}`;
