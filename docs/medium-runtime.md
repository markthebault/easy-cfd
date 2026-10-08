# Medium runtime validation

The OpenFOAM analysis cards are Fast, Medium, Precise (Advanced 1) and Very Precise (Advanced 2).

Medium uses a 0.6 m background cell size, surface refinement level 3, wake level 2, three requested prism layers, a 700,000-cell ceiling, 600 steady iterations and a 4 GiB solver container budget. Its 1,200-second whole-job limit includes preparation, solving, extraction and standard recording. Standard recording does not extend that budget. Detailed DDES wake recording keeps its separate longer budget.

On 2026-10-08 the imported MX-5 NC at 144 km/h and 3 degrees yaw completed in 546.62 seconds (9 minutes 7 seconds). The mesh had 252,736 cells, passed checkMesh, and finished 600 iterations. Run: `7b7d84aa99db47a2a2adc94e4665e86a`. Four MPI ranks were used on this Apple Silicon host. This measures runtime for this model and machine; other runs may stop at the deadline with provisional or incomplete results.

The run remains exploratory. Its saved mesh, residual, force-settling and near-wall warnings are retained; this runtime test does not qualify aerodynamic accuracy. Historical numerical comparisons in VALIDATION.md refer to their original mesh budgets.

Validation: 113 backend tests plus the added legacy-default deadline case; 57 web unit tests; all eight OpenFOAM browser scenarios passed across the main and follow-up runs. Production build and live Tailscale desktop/mobile checks passed. Matching Medium preset history excludes DDES, advanced and old mesh budgets.

Artifacts live under `.easycfd/experiments/medium-20min/`: benchmark-result.json, benchmark-run.json, test logs, and live desktop/mobile screenshots.
