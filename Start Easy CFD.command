#!/usr/bin/env bash
# Double-click from Finder after installing the prerequisites in README.md.
cd "$(dirname "$0")" || exit 1
exec ./scripts/start.sh --open
