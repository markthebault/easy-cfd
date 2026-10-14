export const BACKEND_IMAGE = "markthebault/easy-cfd-backend:latest";
/** One self-contained OpenFOAM/MPI server; only saved data is mounted. */
export const DOCKER_START_COMMAND = `docker run -it --rm --pull=always --name easycfd-openfoam --init \\
  -p 8000:8000 \\
  -v "$HOME/easycfd-data:/data" \\
  ${BACKEND_IMAGE}`;
