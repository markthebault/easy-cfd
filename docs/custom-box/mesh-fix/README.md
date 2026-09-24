# Custom box mesh failure

The Medium run `5c39ba44b8534a71b79b6b300b8067b6` failed after resizing the sample car's box to X = -4.7 through 10.3 m, Y = -3.13 through 3.57 m, and Z = 0 through 3.72 m.

The saved `skewFaces` set contains faces 435427, 435428, 435430 and 435431. All lie in the ground patch, whose face range is 431013 through 435431. The maximum skewness was 4.6500418. Topology, volume and the configured mesh-quality checks passed, but the basic skewness check failed.

The mesher allowed boundary skewness up to 20, while the basic `checkMesh` check rejected values above 4. Both generated dictionaries now require boundary skewness at most 4. The final validation command and its rejection behavior remain intact. Errors now include the failed checks and explain that box dimensions and mesh resolution affect cell quality, instead of always telling the user to repair geometry.

A fresh mesh with the identical geometry, box and Medium settings passes all checks. It has 142,040 cells and maximum skewness 3.34297222, versus 142,056 cells in the failed mesh. No box coordinates, geometry, refinement levels or solver settings were adjusted to obtain the pass.

Regression coverage checks all four preset choices and confirms that skewness or volume failures still prevent the solver from starting. All 67 backend tests pass; Ruff and whitespace checks pass.

The browser reproduction starts a new run from the original project only if its settings and geometry still match the failed snapshot. It checks completion, displayed force values and warnings, and the saved box rendering. Its evidence is recorded in [checks.json](checks.json), [setup.png](setup.png), [result.png](result.png) and [diagnostics.png](diagnostics.png).

Run `9bb542f30646479490a2f4206f1877d7` completed all 1,000 Medium iterations. The browser checks passed without page errors, and the result screenshot was visually inspected. An independent read of `coefficient.dat` confirmed that the last 50 rows average to the saved Cd and Cl, and the iteration 1,000 velocity field exists. The original failed run remains intact.

This fixes the mesh failure, but this run's forces remain provisional: force settling and residual convergence checks both failed. The UI also reports 8.8% tunnel blockage and 72% of sampled wall points in the target y+ range. Cd = 0.6206527626 and Cl = 0.7134297291 must not be treated as validated aerodynamic predictions.

```sh
node scripts/check_box_mesh_fix.mjs 5c39ba44b8534a71b79b6b300b8067b6
```

Passing mesh checks establishes mesh validity under these checks. It does not establish that this smaller domain gives drag independent of boundary placement or validate the demonstration car against an experiment.
