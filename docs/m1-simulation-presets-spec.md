# Simulation presets and resource policy

The frontend exposes lightweight browser OpenFOAM WASM and a native MPI backend. Both preserve conditions, model groups, wheels, road motion and the shared result/viewer API.

| Browser level | Iterations | Cell ceiling | Whole-job ceiling |
|---|---:|---:|---:|
| Quick | 180 | 100,000 | 5 minutes |
| Fast | 300 | 220,000 | 10 minutes |
| Detailed | 1,000 | 600,000 | 60 minutes |

The WASM worker uses one double-precision serial OpenFOAM solver. It checks the mesh and preserves upstream physics; it does not reduce quality silently or fall back to another solver. Cancellation terminates the worker. A browser lease coordinates heavy runs across tabs.

Native Fast, Medium, Precise and Very Precise preserve the existing backend budgets, refinement and recording behavior. The bundled image launches local OpenFOAM tools and MPI ranks, honors cgroup CPU/memory limits and affinity, and monitors the entire process family. Cancellation stops all ranks. Data and token persistence require only the `/data` mount; no Docker socket is needed.

Browser and native cell counts describe different presets and should not be equated with accuracy. Thin surfaces or large assemblies may exceed a browser budget and require the native backend. Numerical parity, residual convergence and mesh sensitivity remain separate from physical qualification.

See [measured browser evidence](../web/VALIDATION.md), [the Docker guide](docker-backend.md) and [backend implementation](../backend/easycfd/local_solver.py).
