# Custom box verification

The browser configured a 30 × 10 × 6 m box around the sample car, chose Custom with Fast mesh resolution, and ran 125 iterations. The saved run and field snapshot both ended at iteration 125. The run's box remained unchanged after editing the project's outlet coordinate.

The browser also checked the live box coordinates, saved-box display, rejection of a box that intersects the car, and returning to Automatic mode. These are workflow checks, not physical validation of the coarse sample result.

[Setup](setup.png) · [Saved result](result.png) · [Browser checks and run ID](browser-checks.json)

Backend coverage checks box ordering, finite numbers, geometry containment, background cell limits, a 20 cm part, custom iteration bounds, generated OpenFOAM dictionaries, saved settings, and comparison mismatches. Existing legacy settings retain their defaults. Custom with Precise resolution uses the finer mesh settings for one solve.

The [mesh failure investigation and fix](mesh-fix/README.md) documents inconsistent boundary-skewness limits and a successful rerun with the user's box unchanged. The mesher now meets the final check's stricter limit; failed checks still stop the solver.

A subsequent fresh default sample ran Medium for 1,000 iterations at 100 km/h with X = -4.7 to 10.3 m, Y = -3.13 to 3.57 m, and Z = 0 to 3.72 m. It passed mesh checks with 138,172 cells. Browser checks verified Cd = 0.6050, Cl = 0.6033 and the saved box display. Forces remain provisional because settling and residual targets were not reached; the UI also reports 8.8% blockage. See [saved measurements](default-medium.json) and [the result screen](default-medium.png).

Reproduce with the local server running:

```sh
uv run pytest -q
npm --prefix frontend run build
node scripts/check_custom_box_ui.mjs
```
