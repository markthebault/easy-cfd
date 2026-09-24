# Live dimensions and rotation demo

Watch [live-dimensions.mp4](live-dimensions.mp4). Recorded from the working local app using `scripts/record_transform_demo.mjs`.

The demo uses the previously sealed Z4 fixture from the merge demo. It sets a target length of 4,500 mm, rotates 90 degrees, resets, then rotates 15 degrees and sets the target length again before reviewing and applying. Dimensions measure bounds along the displayed world axes. Scaling preserves proportions.

The saved STL measures 4.5 × 2.8421593904 × 1.1987683848 metres and remains watertight. The browser reported no JavaScript errors. This verifies the geometry editing workflow, not a CFD simulation or the accuracy of the source car model.

Validation: 54 backend tests, three browser workflows covering repair, merge/seal, and transforms, Ruff, and the frontend production build. The transform browser test covers exact sizing, live canvas changes without server requests, units, nonorthogonal rotations, unchanged unselected objects, saved dimensions, and mobile layout.
