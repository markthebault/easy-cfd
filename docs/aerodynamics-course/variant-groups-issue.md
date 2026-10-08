The course provides flat, 7-degree diffuser, and 14-degree diffuser body meshes. A diffuser body replaces the original lower surface. Simulating the original closed body and a replacement together blocks the intended passage and can corrupt force interpretation. Wing variants also need mutual exclusion.

The current groups UI's `Only this` leaves Body and Wheels on, deliberately. Consequently enabling a replacement-body group with this action retains the flat body. Course instructions require manually switching the baseline body off, but the app should make the dependency concrete and reviewable.

Acceptance:

- Add user-declared mutually exclusive variant sets, with an exactly-one option for replacement bodies and an at-most-one option for wings.
- Selecting a member disables the other members' **groups**, while retaining all members' part switches/grid-shaping geometry for shared-grid comparisons.
- Model a replacement relationship to the base body without forcing automatic filename heuristics; existing normal Body/Wheels behaviour stays valid for ordinary additive devices.
- Show a clear preflight error for zero or multiple required body versions; preview which surfaces are replaced. Never silently union overlapping replacement shells.
- Preserve variant-set metadata and effective enabled parts in saved designs, runs, reopen/import/export, and Compare; older designs remain usable.
- Regression-test flat-to-diffuser switching, one/two/no active body cases, wing exclusion, shared-grid identity, old designs, and reopening after a run.

Related code: `web/src/store/geometry.ts`, `web/src/store/app.ts`, `web/src/ui/GroupsPanel.tsx`. This is a geometry/experiment integrity feature, not an aerodynamic-accuracy fix.
