# MX-5 NC geometry and result

Mazda Miata MX-5 Roadster 2009 by Nieve5677:
https://sketchfab.com/3d-models/mazda-miata-mx-5-roadster-2009-6043376527844ec9ae85ac46b322b71d
Author: https://sketchfab.com/iori308408
License: CC BY 4.0, https://creativecommons.org/licenses/by/4.0/

Modified for EasyCFD: exterior reconstruction, sealed body/underbody, interior removal, simplified closed tire envelopes, scale/orientation changes and meshing. These changes are documented in docs/mx5-nc-surface-quality.md. This is the exact prepared geometry associated with the saved OpenFOAM run in manifest.json; no geometry was remeshed for the track viewer.

The velocity and wall-pressure samples are saved OpenFOAM output for this prepared car at 144 km/h and 3 degrees yaw. They are provisional numerical results, not experimental measurements or validated MX-5 aerodynamic data. Solver quality limitations and source hashes remain in manifest.json.

`map.json` adds six independently solved cases for the same prepared car: 40 and 240 km/h, each at -10, 0 and +10 degrees yaw. They share a 39,383-cell Fast mesh. Per-case source run IDs, exact-data hashes, force coefficients and convergence warnings remain in the map; the 240 km/h / 0-degree force result is unsettled. This map is exploratory and has not been mesh-converged or experimentally validated.
