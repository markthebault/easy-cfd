#!/usr/bin/env python3
"""Standalone force-agreement figures from the retained numerical evidence."""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import NullLocator

ROOT = Path(__file__).resolve().parents[2]
FOLDER = ROOT / "docs/webgpu-accuracy"


def main():
    evidence = json.loads((FOLDER / "evaluation.json").read_text())
    figure, axes = plt.subplots(2, 4, figsize=(15, 7), sharex=True)
    models = ["sample", "mx5", "sample-wing", "ahmed25"]
    kinds = [("baseline", "#5274a1"), ("stress-omega", "#d17b34"), ("focused-stress", "#347867")]
    for column, model in enumerate(models):
        for row, metric in enumerate(["cdError", "clError"]):
            axis = axes[row, column]
            for kind, colour in kinds:
                points = [trial for trial in evidence["trials"] if trial["model"] == model and trial["status"] == "completed" and kind in trial["key"] and trial["evaluation"].get(metric) is not None]
                if not points:
                    continue
                axis.scatter([p["cells"] for p in points], [100*p["evaluation"][metric] for p in points], color=colour, s=35, alpha=.85, label=kind)
            axis.axhline(3, color="#444444", linewidth=1, linestyle="--", label="3% target")
            axis.set_xscale("log")
            axis.set_xticks([125000, 250000, 500000, 1000000, 2000000], ["125k", "250k", "500k", "1M", "2M"])
            axis.xaxis.set_minor_locator(NullLocator())
            axis.set_yscale("symlog", linthresh=3)
            values = [100*t["evaluation"].get(metric, 0) for t in evidence["trials"] if t["model"] == model and t["status"] == "completed" and any(kind in t["key"] for kind, _ in kinds)]
            axis.set_ylim(0, max(110, 1.1*max(values, default=0)))
            axis.grid(True, alpha=.18)
            axis.set_title(f"{model}, {'drag' if row == 0 else 'lift'}")
            axis.spines[["top", "right"]].set_visible(False)
            if column == 0:
                axis.set_ylabel("Coefficient disagreement (%)")
            if row == 1:
                axis.set_xlabel("Cartesian cells")
    handles, labels = axes[0, 0].get_legend_handles_labels()
    figure.legend(handles, labels, loc="lower center", ncol=4, frameon=False)
    figure.suptitle("WebGPU versus OpenFOAM: refinement does not establish 3% agreement", fontsize=15, y=.98)
    figure.tight_layout(rect=[0, .05, 1, .95])
    figure.savefig(FOLDER / "refinement.png", dpi=160)
    figure.savefig(FOLDER / "refinement.svg")
    plt.close(figure)
    suite = [case for case in evidence["suite"] if all(key in case["result"] for key in ("cd", "cl"))]
    if suite:
        figure, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True)
        labels = [case["model"] for case in suite]
        for axis, coefficient in zip(axes, ["cd", "cl"]):
            positions = list(range(len(suite)))
            reference = [case["reference"][coefficient] for case in suite]
            gpu = [case["result"][coefficient] for case in suite]
            axis.vlines(positions, reference, gpu, color="#9aa4ab", linewidth=2)
            axis.scatter(positions, reference, label="OpenFOAM", color="#5274a1", s=50, marker="s")
            axis.scatter(positions, gpu, label="WebGPU, 500,000 cells", color="#d17b34", s=50)
            axis.axhline(0, color="#777777", linewidth=.6)
            axis.set_ylabel("Drag Cd" if coefficient == "cd" else "Signed lift Cl")
            axis.grid(True, axis="y", alpha=.18)
            axis.spines[["top", "right"]].set_visible(False)
        axes[1].set_xticks(list(range(len(labels))), labels, rotation=20, ha="right")
        axes[0].legend(frameon=False, ncol=2)
        figure.suptitle("Final 500,000-cell comparison; references have qualification limits", fontsize=14)
        figure.tight_layout()
        figure.savefig(FOLDER / "final-comparison.png", dpi=160)
        figure.savefig(FOLDER / "final-comparison.svg")
        plt.close(figure)
    for filename in ("refinement.svg", "final-comparison.svg"):
        path = FOLDER / filename
        if path.exists():
            path.write_text("\n".join(line.rstrip() for line in path.read_text().splitlines()) + "\n")


if __name__ == "__main__":
    main()
