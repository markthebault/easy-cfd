The new car-aerodynamics course needs controlled ride-height/rake/yaw studies (Lessons 15-17 and 22). The current app supports a single case, group comparisons, custom quality/domain settings, a global road-height shift, and speed/yaw inputs. It does not provide a reproducible operating-map queue or a sprung-body pose study relative to fixed wheel centres. This request is separate from numerical qualification (#16) and report presentation (#15).

Current source: `web/src/solver/setup.ts` derives the longitudinal inlet and road velocity from `speed_kmh`, with lateral inlet `speed * tan(yaw)`. `backend/easycfd/foam.py` uses the same road-speed convention. This already keeps road motion longitudinal; preserve it. The missing capability is independent ambient headwind/tailwind versus vehicle road speed, plus explicit pose variants.

Acceptance:

- Provide a bounded queue/matrix for independent speed, ambient longitudinal/lateral wind, front/rear sprung-body height or pitch, and selected part-group configurations. Start with explicit static poses, not a dynamics claim.
- Keep tyre centres/contact geometry and road speed physically consistent when the sprung body moves; do not shift tyres through the road. Preview each pose and reject ground penetration or invalid gaps.
- Derive inlet velocity from an explicit road/wind triangle. Ground motion stays longitudinal at road speed; wheel rotation follows road speed. Save airspeed, yaw, road speed, and axis/normalisation conventions separately.
- Retain immutable geometry/settings per run, shared-grid identity where supported, actual cell counts, averaging windows, force/moment/axle-load histories, failures, and warnings. Never imply accuracy from completion.
- Offer cancellation, memory/time limits, resume, a clearly bounded initial matrix, and CSV/JSON exports. A failed or unsettled case remains visible in its map cell.
- Analyse both yaw signs and preserve a full-car option rather than silently enforce symmetry.
- Verify pose kinematics, wind-vector arithmetic, rolling direction, grid/provenance handling, cancellation/resume, and both engine mappings before numerical qualification.

Aero-map values remain exploratory until qualified. This does not request porpoising prediction, suspension dynamics, or fitted performance corrections.
