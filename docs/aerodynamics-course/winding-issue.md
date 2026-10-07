## Problem

A closed STL can have exactly two triangles per undirected edge while adjacent faces still traverse that edge in the same direction. The current `openEdges()` check in `web/src/geometry/model.ts` counts undirected incidences, so it cannot identify this inconsistency. This matters to inside/outside decisions, outward sampling, and wall-stress transfer.

During course preparation, an extruded car body passed the closed-edge count but had caps and side walls with inconsistent orientation. The course generator now checks both edge incidence and directed orientation, normalizes its profiles, and regenerates the evidence from the corrected geometry. This check belongs in normal import diagnostics as well.

## Requested behaviour

- Inspect welded topology per connected component, reporting open boundaries, non-manifold edges, inconsistent adjacent face orientation, and a negative signed volume for a closed orientable shell.
- Explain that watertightness alone does not establish correct outward normals. Show the affected part and a count/example of offending faces or edges.
- Offer a reviewable orientation repair for supported closed orientable components, retaining the original source and documenting changed triangles. Do not silently seal deliberate gaps or infer orientation for arbitrary open sheets.
- Retain the diagnostic and any repair provenance in saved runs and exports.
- Use a documented welding tolerance, handle multi-shell parts and mirrored imports, and keep preparation bounded for the existing triangle limits.

## Acceptance evidence

Use fixtures for a correctly oriented closed box, the same box with reversed caps, a wholly reversed closed box, two disconnected closed components, an open plate, and a non-manifold edge. The reversed-cap fixture must not pass as an ordinary solid merely because each undirected edge occurs twice. Show diagnostics before solving and verify any repaired output's topology/orientation separately from aerodynamic accuracy.

Related: #16 addresses numerical qualification; this issue concerns input geometry diagnostics.
