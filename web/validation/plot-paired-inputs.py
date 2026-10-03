#!/usr/bin/env python3
"""Standalone paired CFD figures. Run only on the saved pilot statistics."""
import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
COLORS = ("#236d86", "#c36d24")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/webgpu-paired-inputs")
    args = parser.parse_args()
    output = ROOT / args.output
    data = json.loads((output / "statistics.json").read_text())
    stages = [(stage, result) for stage, result in data["stages"].items() if result["pairedCount"]]
    if not stages:
        raise RuntimeError("No complete pairs to plot")
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})
    fig, axes = plt.subplots(len(stages), 3, figsize=(12, 4*len(stages)), squeeze=False, layout="constrained")
    for row, (stage, result) in enumerate(stages):
        pairs = result["pairs"]
        for column, name in enumerate(("Cd", "Cl")):
            ax = axes[row, column]
            native = [p[f"native{name}"] for p in pairs]
            gpu = [p[f"gpu{name}"] for p in pairs]
            boxes = ax.boxplot([native, gpu], positions=[1, 2], tick_labels=["OpenFOAM", "WebGPU"], widths=.38, patch_artist=True,
                medianprops={"color": "#16242d", "linewidth": 2}, boxprops={"linewidth": 1}, whis=(0, 100), showfliers=False)
            for box, color in zip(boxes["boxes"], COLORS):
                box.set_facecolor(color)
                box.set_alpha(.3)
            jitter = np.linspace(-.08, .08, len(pairs))
            for i, (a, b) in enumerate(zip(native, gpu)):
                ax.plot([1+jitter[i], 2+jitter[i]], [a, b], color="#b2bdc5", lw=.7, zorder=1)
            ax.scatter(1+jitter, native, color=COLORS[0], s=22, label="OpenFOAM", zorder=3)
            ax.scatter(2+jitter, gpu, color=COLORS[1], s=22, label="WebGPU", zorder=3)
            ax.set_title(f"{stage.capitalize()}: {name}, {len(pairs)} matched pairs")
            ax.set_ylabel(name)
            ax.grid(axis="y", alpha=.2)
        ax = axes[row, 2]
        x = np.arange(1, len(pairs)+1)
        ax.axhspan(-5, 5, color="#72ad80", alpha=.17, label="±5% target")
        ax.axhline(0, color="#677782", lw=.7)
        for name, color in zip(("Cd", "Cl"), COLORS):
            n = np.array([p[f"native{name}"] for p in pairs])
            g = np.array([p[f"gpu{name}"] for p in pairs])
            signed = 100*(g-n)/np.maximum(np.abs(n), .01)
            ax.plot(x, signed, marker="o", color=color, label=name)
        ax.set_title("Difference within each pair")
        ax.set_ylabel("100 × (GPU − native) / |native| (%)")
        ax.set_xlabel("Registered pair (speed increases left to right)")
        ax.set_xticks(x)
        ax.grid(axis="y", alpha=.2)
        ax.legend(frameon=False)
    fig.suptitle("Same geometry and physical inputs; one frozen WebGPU solver", fontsize=14)
    fig.savefig(output / "paired-comparison.png", dpi=180)
    fig.savefig(output / "paired-comparison.svg")
    plt.close(fig)
    fig, axes = plt.subplots(len(stages), 2, figsize=(11, 3.7*len(stages)), squeeze=False, layout="constrained")
    for row, (stage, result) in enumerate(stages):
        pairs = result["pairs"]
        x = np.arange(1, len(pairs)+1)
        for column, name in enumerate(("Cd", "Cl")):
            ax = axes[row, column]
            native = np.array([p[f"native{name}"] for p in pairs])
            gpu = np.array([p[f"gpu{name}"] for p in pairs])
            lower = np.array([p[f"{name.lower()}NativeBlockEnvelopeLow"] for p in pairs])
            upper = np.array([p[f"{name.lower()}NativeBlockEnvelopeHigh"] for p in pairs])
            ax.fill_between(x, native-.05*np.abs(native), native+.05*np.abs(native), color="#72ad80", alpha=.15, label="±5% around native mean")
            ax.vlines(x, lower, upper, color=COLORS[0], linewidth=2, label="Native block-mean range")
            ax.scatter(x, native, s=20, color=COLORS[0], label="Native final-window mean")
            ax.scatter(x, gpu, s=32, marker="x", color=COLORS[1], label="GPU final-window mean")
            ax.set_title(f"{stage.capitalize()}: {name}")
            ax.set_xticks(x)
            ax.set_xlabel("Registered pair")
            ax.set_ylabel(name)
            ax.grid(axis="y", alpha=.2)
            if row == 0 and column == 1:
                ax.legend(frameon=False, fontsize=8)
    fig.suptitle("Native iteration variation versus GPU difference\nBars span eight final 25-iteration block means; they are descriptive ranges", fontsize=12)
    fig.savefig(output / "native-variation.png", dpi=180)
    fig.savefig(output / "native-variation.svg")
    plt.close(fig)
    for file in (output / "paired-comparison.svg", output / "native-variation.svg"):
        file.write_text("\n".join(line.rstrip() for line in file.read_text().splitlines())+"\n")
    print(f"Saved figures for {sum(r['pairedCount'] for s,r in stages)} matched pairs")


if __name__ == "__main__":
    main()
