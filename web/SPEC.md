# Browser OpenFOAM requirements

The frontend is entirely static. It provides real OpenFOAM WebAssembly meshing and steady airflow calculations with Quick, Fast and Detailed presets. Advanced native OpenFOAM analysis uses an explicitly connected, authenticated backend.

- Browser runs require WebAssembly, workers and WebGL; computation uses double-precision serial SIMPLE / k–omega SST.
- Quick: 180 iterations and at most 100,000 cells. Fast: 300 and 220,000. Detailed: 1,000 and 600,000.
- Preserve model import, conditions, groups, wheels, road motion, simulation boxes, results, shared comparisons, saving/reopening and JSON/CSV/PNG exports.
- Never display synthetic results or fall back to another solver after failure.
- Sample forces, moments, pressure, stress and flow from computed OpenFOAM output. Report native integration and averaging provenance.
- Use iteration-based force histories. Transient recordings remain a native-server feature.
- Browser runs must work with all API/off-origin requests blocked. Static hosting requires no solver server, Function, shared memory or cross-origin isolation.
- Remove the retired solver's source, preprocessing, shaders, worker, benchmarks, tests, settings, result labels and direct dependencies. Preserve shared OpenFOAM data and visualization contracts.
- Reject unsupported stored results and keep designs available for rerunning; do not delete stored user data.

See [the technical guide](../TECHNICAL_GUIDE.md), [runtime validation](VALIDATION.md) and [the WASM build](../wasm/README.md).
