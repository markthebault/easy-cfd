"""Bounded subprocess entry point for native viewer sampling."""

import gzip
import json
import sys
from pathlib import Path
import numpy as np
from .webview import FieldRequest, sample_field, sample_stress, sample_surface


def main():
    folder = Path(sys.argv[1])
    args = json.loads((folder / "request.json").read_text())
    results = Path(args["results"])
    if args["kind"] == "field":
        payload = sample_field(results, FieldRequest(**args["grid"]))
    else:
        positions = np.fromfile(folder / "positions.bin", dtype="<f4").astype(np.float64)
        payload = sample_surface(results, positions, args["freestream"])
        if args["version"] == 2:
            stress, valid = sample_stress(results, positions, args["part_id"])
            header = np.array([0x53464345, 2, len(positions) // 3, args["iteration"]], dtype="<u4").tobytes()
            payload = header + payload + stress.tobytes() + valid.tobytes()
    (folder / "response.bin.gz").write_bytes(gzip.compress(payload, compresslevel=1))


if __name__ == "__main__":
    main()
