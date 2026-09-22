"""A reproducible comparison with the published AhmedML run 1 computational reference.

The source case is nondimensional (U=1, nu=3.75e-7). Using U=40 and nu=1.5e-5
preserves Reynolds number. k scales with U² and omega with U. This is a
comparison against hybrid RANS/LES, not validation against a wind-tunnel test.
"""

import re

REFERENCE = {
    "name": "AhmedML run 1",
    "source": "https://huggingface.co/datasets/neashton/ahmedml",
    "paper": "https://arxiv.org/abs/2407.20801",
    "geometry_sha256": "3c8a4d3c6959a94b2e2451204d77a0b41e4f5253e3f40926a2ffa461f3d9641f",
    "coefficients_sha256": "1cd9613af910c763bd8cd50fc4573454c1d8c7977148bbf0b972f6619aba1723",
    "cd": 0.23848566658,
    "cl": -0.094516081781,
    "reference_area": 0.112032,
    "speed_kmh": 144,
    "density": 1,
    "clearance": 0.0499937534,
    "translation": [0.5939961053953552, -0.00002233684062958, 0],
}


def domain():
    x, y, _ = REFERENCE["translation"]
    return [-4 + x, 6 + x, -1 + y, 1 + y, 0, 1.4]


def apply_boundaries(case, metadata):
    # Lateral slip walls match the published setup. Top symmetry is equivalent to slip
    # for this flat boundary. The floor is stationary and wheel rotation is disabled.
    for field in ("U", "p", "k", "omega", "nut"):
        path = case / "0" / field
        text = path.read_text()
        condition = "type slip;" if field == "U" else "type zeroGradient;"
        text = re.sub(r"sides\s*\{[^}]*\}", f"sides {{{condition}}}", text)
        path.write_text(text)
    metadata["benchmark"] = REFERENCE
    return metadata
