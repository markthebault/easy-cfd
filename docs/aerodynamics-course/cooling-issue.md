The course teaches cooling drag and front/floor interactions (Lesson 12), but the current browser external-flow settings have no radiator resistance or duct mass-flow model. Closing a grille on a sealed external car can look like a drag improvement while eliminating the required cooling. A surface-pressure picture does not establish radiator flow or heat rejection.

Acceptance for an initial physically explicit feature:

- Import/prepare inlet, duct, core, and outlet geometry with a reviewable flow path. Preserve openings during repair/meshing; reject a closed or unresolved passage instead of returning invented flow.
- Allow a documented porous-core pressure-loss relation, such as linear plus quadratic resistance, fitted to user-supplied core data with declared units, area, velocity convention, and valid range. Record its provenance.
- Report signed mass flow, core pressure drop, loss/force contribution, and whole-car drag/lift/moment changes over comparable conditions; separate core forces from outer-body interaction.
- Explicitly distinguish isothermal pressure-loss modeling from a thermal/heat-rejection calculation. Do not label the former cooling-qualified without a thermal duty and suitable model/data.
- Start in a capable local OpenFOAM path if the browser solver cannot support it reliably; gate unavailable editions honestly.
- Validate an independent duct/resistance benchmark, mesh/gap sensitivity, pressure/mass-flow conservation, coefficient units, and repeated reopen/export behaviour before car claims.

Existing external-force reporting (#15) and aero qualification (#16) remain relevant, but neither supplies this missing physical subsystem. Thermal simulation, rotating fans, and detailed conjugate heat transfer can be explicitly staged after the initial pressure-loss feature.
