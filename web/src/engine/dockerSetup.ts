export const BACKEND_IMAGE = "markthebault/easy-cfd-backend:latest";
/** Works from any directory on macOS/Linux; matches the backend's sibling-container mounts. */
export const DOCKER_START_COMMAND = `docker run -it --rm --pull=always --name easycfd-openfoam --init \\
  -p 127.0.0.1:8000:8000 \\
  -v "$HOME/easycfd-data:/data" \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -e EASYCFD_HOST_DATA="$HOME/easycfd-data" \\
  ${BACKEND_IMAGE}`;
