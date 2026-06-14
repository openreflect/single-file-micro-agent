#!/usr/bin/env python3
"""Validate a public-safe Single File Micro Agent task manifest."""

from __future__ import annotations

import json
import sys
from pathlib import Path


REQUIRED_FIELDS = {
    "name": str,
    "workspace": str,
    "modelAdapter": str,
    "allowedCommands": list,
    "inputs": list,
    "outputs": list,
    "maxTurns": int,
    "dryRunDefault": bool,
}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_task.py path/to/task-manifest.json", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))

    errors: list[str] = []
    for key, expected_type in REQUIRED_FIELDS.items():
        if key not in data:
            errors.append(f"missing field: {key}")
        elif not isinstance(data[key], expected_type):
            errors.append(f"wrong type for {key}: expected {expected_type.__name__}")

    if isinstance(data.get("maxTurns"), int) and data["maxTurns"] < 1:
        errors.append("maxTurns must be at least 1")

    if errors:
        print("TASK_INVALID")
        for error in errors:
            print(f"- {error}")
        return 1

    print("TASK_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
