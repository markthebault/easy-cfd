---
name: easy-cfd-blender
description: Prepare car models in Blender for EasyCFD import and verify them with a Fast run, including when the user asks for computer use of an open Blender session.
---

# Blender models for EasyCFD

Read the current [Blender export guide](../../../frontend/src/BlenderGuide.tsx) and [import requirements](../../../README.md#importing-geometry) before editing a model. Use this skill for geometry preparation and validation; the app and its current code are the authority for limits and UI labels.

1. **Inspect the source.** If Blender is open and the user asked for computer use, inspect that session with the computer-use tool. Check the object list and the car from the front, side, top, and rear before changing geometry. Identify the body, four tires, wing, supports, and decorative or internal parts. Save a working copy so the supplied model remains recoverable.

2. **Prepare the exterior.** Keep the assembled positions and real scale. For the guide's coordinate setup, use metres, nose −Y, and up +Z. Make one closed body and four separate closed tire envelopes whose axles run across the car. Make aero parts closed solids. Remove unneeded interior and duplicate surfaces. A visual decimation alone does not close an open shell; reconstruct only the exterior needed for the CFD question. Preserve functional gaps, especially the space under a rear wing. Inspect the actual mesh after remeshing and smoothing: smooth shading changes appearance, not shape or watertightness.

3. **Export and check.** Apply transforms and export one binary STL per part with shared coordinates. Check every STL for a closed, consistently wound surface and positive volume, then confirm assembly dimensions and wheel locations. Keep an editable Blender file matching the exported assembly. When controlling Blender through computer use, use the application's UI and visual checks for interactive steps; Blender's Python console can handle repeatable operations. If the interactive app fails, use a separate Blender background process on a saved copy and reopen the result for verification.

4. **Verify in EasyCFD.** Import all STLs together, select the export units and axes, and set a physically plausible road clearance. Assign all four tire parts the **Wheel** role and check each radius. Rotate the preview to confirm the wing gap, wheel arches, and ride height. Run **Fast**. Completion means the mesh passes checks, the solve finishes, and the force history and residual status are reviewed. For a failure, inspect log.checkMesh, change the implicated geometry or clearance, and rerun. Treat Fast forces as exploratory; review near-wall warnings and refine the mesh before design claims.

Deliver the tested STLs, matching Blender file, import settings, visual evidence, and the geometry approximations that affect interpretation.
