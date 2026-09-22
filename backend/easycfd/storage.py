import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

ROOT = Path(os.environ.get("EASYCFD_DATA", str(Path(__file__).resolve().parents[2] / ".easycfd"))).resolve()
LOCK = threading.RLock()


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier():
    return uuid4().hex


def directory(kind, key):
    if kind not in ("projects", "runs") or not re.fullmatch(r"[a-f0-9]{32}", key):
        raise FileNotFoundError("Unknown project or run")
    return ROOT / kind / key


def save(kind, data):
    with LOCK:
        folder = directory(kind, data["id"])
        folder.mkdir(parents=True, exist_ok=True)
        temp = folder / "record.tmp"
        temp.write_text(json.dumps(data, indent=2, allow_nan=False))
        temp.replace(folder / "record.json")


def get(kind, key):
    return json.loads((directory(kind, key) / "record.json").read_text())


def all_records(kind):
    parent = ROOT / kind
    if not parent.exists():
        return []
    return sorted(
        [json.loads(p.read_text()) for p in parent.glob("*/record.json")],
        key=lambda x: x["created"],
        reverse=True,
    )


def update(kind, key, **changes):
    with LOCK:
        data = get(kind, key)
        data.update(changes)
        save(kind, data)
        return data
