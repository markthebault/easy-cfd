"""Make a labelled fragmented-Z4 fixture from a prepared local model, without editing it."""

import argparse
from pathlib import Path
import numpy as np
import trimesh
from easycfd.seal import component_count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("body", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    mesh = trimesh.load_mesh(args.body)
    centers = mesh.triangles_center
    divisions = np.array([20, 10, 1])
    cell = np.minimum(((centers - mesh.bounds[0]) / mesh.extents * divisions).astype(int), divisions - 1)
    groups = cell[:, 0] * 10 + cell[:, 1]
    pieces = []
    for group in np.unique(groups):
        piece = mesh.submesh([np.flatnonzero(groups == group)], append=True, repair=False)
        center = piece.bounds.mean(axis=0)
        # Small, explicit cracks between panels. Unmodified source stays on disk.
        piece.vertices = center + (piece.vertices - center) * 0.995
        pieces.append(piece)
    result = trimesh.util.concatenate(pieces)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.export(args.output)
    loaded = trimesh.load_mesh(args.output)
    print(
        f"{len(loaded.faces)} triangles; {component_count(loaded)} disconnected components; watertight={loaded.is_watertight}"
    )


if __name__ == "__main__":
    main()
