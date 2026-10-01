"""One bounded native extraction process, supervised and cancelled by the queue worker."""

import json
import sys
from pathlib import Path
from .results import process

if __name__ == "__main__":
    case, output, run_file, meta_file = map(Path, sys.argv[1:])
    result = process(case, output, json.loads(run_file.read_text()), json.loads(meta_file.read_text()))
    (output / ".extracted.json").write_text(json.dumps(result, allow_nan=False))
