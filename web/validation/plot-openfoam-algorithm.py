#!/usr/bin/env python3
"""Plot raw coefficient comparisons without turning agreement into qualification."""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/webgpu-openfoam-algorithm"


def main():
    records = [json.loads(f.read_text()) for f in sorted((EVIDENCE / "iterations").glob("*.json"))]
    references = json.loads((EVIDENCE / "references.json").read_text())
    completed = [r for r in records if r["status"] == "completed"]
    failed = [r["iteration"] for r in records if r["status"] == "failed"]
    plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})
    fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True, constrained_layout=True)
    for ax, coefficient in zip(axes, ["cd", "cl"]):
        for algorithm, colour, marker in [("explicit-projection", "#186da0", "o"), ("staggered-SIMPLE", "#e28e14", "s"), ("staggered-SIMPLEC", "#24814b", "^")]:
            rows = [r for r in completed if r["result"].get("algorithm", "staggered-SIMPLE" if r["settings"].get("simpleMomentum") else "explicit-projection") == algorithm]
            error = [100*abs(r["result"][coefficient]-references[r["model"]][coefficient])/max(abs(references[r["model"]][coefficient]), .01) for r in rows]
            ax.scatter([r["iteration"] for r in rows], np.maximum(error, .01), s=40, c=colour, marker=marker, label=algorithm)
        if failed:
            ax.scatter(failed, [1200]*len(failed), c="#888888", marker="x", label="failed attempt")
        ax.axhline(5, c="#b54432", ls="--", lw=1.5, label="5% target")
        ax.set_yscale("log")
        ax.set_ylim(.1, 1600)
        ax.grid(axis="y", alpha=.17)
        ax.set_ylabel(("Drag Cd" if coefficient == "cd" else "Signed lift Cl")+" error (%)")
    axes[0].legend(ncol=3, fontsize=9)
    axes[1].set_xlabel("Attempted model solve (failures consume a slot)")
    axes[1].set_xlim(0, 51)
    axes[1].set_xticks([1, 10, 20, 30, 40, 50])
    fig.suptitle("Source-derived WebGPU experiments against matched OpenFOAM references")
    fig.savefig(EVIDENCE / "iterations.png", dpi=160)
    fig.savefig(EVIDENCE / "iterations.svg")
    plt.close(fig)

    rows = [r for r in completed if r["key"].startswith("final-") and "repeat" not in r["key"]]
    if rows:
        fig, axes = plt.subplots(2, 1, figsize=(12, 8), sharex=True, constrained_layout=True)
        x = np.arange(len(rows))
        for ax, coefficient in zip(axes, ["cd", "cl"]):
            native = [references[r["model"]][coefficient] for r in rows]
            gpu = [r["result"][coefficient] for r in rows]
            ax.bar(x-.18, native, .36, color="#b87c22", label="OpenFOAM v2412")
            ax.bar(x+.18, gpu, .36, color="#186da0", label="WebGPU")
            ax.axhline(0, c="#888888", lw=.7)
            ax.set_ylabel("Cd" if coefficient == "cd" else "Signed Cl")
            ax.grid(axis="y", alpha=.15)
        axes[0].legend()
        axes[1].set_xticks(x, [r["model"] for r in rows])
        fig.suptitle("Final 500,000-grid-cell runs: drag and signed lift")
        fig.savefig(EVIDENCE / "final-comparison.png", dpi=160)
        fig.savefig(EVIDENCE / "final-comparison.svg")
        plt.close(fig)

    for file in EVIDENCE.glob("*.svg"):
        file.write_text("\n".join(line.rstrip() for line in file.read_text().splitlines())+"\n")


if __name__ == "__main__":
    main()
