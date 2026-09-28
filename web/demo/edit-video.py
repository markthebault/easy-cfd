"""Speeds up the solver waits of the recorded walkthrough and encodes an MP4.
Usage: python3 demo/edit-video.py /tmp/groups-video docs/groups-walkthrough.mp4"""
import glob, json, subprocess, sys

src_dir, out = sys.argv[1], sys.argv[2]
src = glob.glob(f"{src_dir}/*.webm")[0]
seg = json.load(open(f"{src_dir}/segments.json"))
SPEED = 6.0
cuts, t = [], 0.0
for a, b in seg["waits"]:
    cuts.append((t, a, 1.0))
    cuts.append((a, b, SPEED))
    t = b
cuts.append((t, seg["total"] + 5, 1.0))
parts, labels = [], []
for i, (a, b, s) in enumerate(cuts):
    parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{s}[v{i}]")
    labels.append(f"[v{i}]")
graph = ";".join(parts) + f";{''.join(labels)}concat=n={len(labels)}:v=1:a=0,fps=24,scale=1280:-2[out]"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-filter_complex", graph, "-map", "[out]",
                "-c:v", "libx264", "-preset", "slow", "-crf", "33", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], check=True)
print("wrote", out)
