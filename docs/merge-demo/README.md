Watch [the 81-second walkthrough](merge-seal-walkthrough.mp4). It records the real UI and API with explanatory captions: the 100-part import failure, grouped import, reconstruction settings, original/preview comparison, apply, and STL download.

This is a controlled fixture made from the existing prepared Z4 body. The preparation script partitions its surface into panels and slightly separates them, producing 354 disconnected components. The original internet download was not available. Wheels are excluded from this demonstration, rather than merged into the body. User source projects were read only.

The final preview uses 15 mm resolution and a 30 mm gap target. It produces one watertight, consistently wound surface with positive volume and 263,508 triangles. Reloading the downloaded STL confirmed those properties. Its bytes match the saved preview geometry, and the uploaded original remains unchanged.

Across 4,000 deterministic samples per direction, the 95th-percentile new-to-original distance is 11.95 mm and the original-to-new distance is 12.16 mm. The largest sampled distance in either direction is 41.49 mm. These are not maximum-error guarantees or area-weighted measurements. The surface is reconstructed and smoothed, so small details and gaps can change. No CFD mesh or solver was run.

Validation passed: 50 backend tests, Ruff, the production frontend build, both repair browser workflows, and an additional final merge/seal browser run. Checks include preserving unselected wheel geometry/settings, refusing disconnected islands or an open thickened skin, memory-budget rejection, stale-preview rejection, discard, apply, export, and a narrow viewport. The recording reported no browser exceptions. The build retains the existing bundle-size warning.

The recording used a separate local data directory. Model archives and temporary result records are not included in the repository. Reproduction scripts are `scripts/prepare_merge_demo.py` and `scripts/record_merge_demo.mjs`; they require a locally supplied prepared model.
