# Aerodynamic analysis contract

Browser WASM and native OpenFOAM runs share force, moment, component, axle-load and field contracts. The retired browser solver and its numerical studies have been removed.

- Coordinates: nose toward −X, airflow toward +X, +Z up, road at Z = 0. Lift is +Z; pitch about +Y is nose-up.
- Confirmed or detected axles define a road-plane moment origin below the front axle. Equivalent axle loads conserve total lift and include pitch from drag acting above the road.
- Forces and moments use the same averaging window. Histories identify solver iterations. Surface pressure and stress are actual computed samples and include validity masks and snapshot provenance.
- Stress is physical traction in Pa; Cf uses the recorded dynamic pressure. Missing stress stays unavailable. Near-wall velocity is used for flow direction, not reported as friction.
- Component forces and moments reconcile with whole-car integrals. Native mesh levels remain separate; report the last completed mesh and observed sensitivity.
- Tyre load estimates combine saved aerodynamic moments and optional mass/front weight. Missing or ambiguous inputs stay unavailable. Do not infer cornering, braking, suspension or per-wheel left/right loads.
- Results, saved/reopened fields, comparisons, JSON, CSV and PNG preserve these units, origins and provenance. Compare shares colour scales and identifies changed conditions and groups.
- Static browser checks use real WASM calculations with no backend requests. Native checks use actual MPI cases plus API/UI contract tests.
- Numerical parity and software verification do not establish physical accuracy. Settling, residual convergence, mesh sensitivity and physical validation remain separate assessments.

See [current browser validation](../web/VALIDATION.md), [analysis notes](aerodynamic-analysis/README.md) and [the technical guide](../TECHNICAL_GUIDE.md).
