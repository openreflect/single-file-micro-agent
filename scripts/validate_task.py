#!/usr/bin/env python3
"""Validate a public-safe Single File Micro Agent task manifest (schema v2)."""

from __future__ import annotations

import json
import sys
from pathlib import Path


REQUIRED_FIELDS = {
    "name": str,
    "workspace": str,
    "modelEndpoints": list,
    "allowedCommands": list,
    "inputs": list,
    "outputs": list,
    "maxTurns": int,
    "dryRunDefault": bool,
}

ENDPOINT_REQUIRED = {"name": str, "provider": str, "model": str}
ENDPOINT_OPTIONAL = {"baseUrl": str, "priors": dict}
PRIOR_CLASSES = {"reasoning", "mechanical"}

TUNING_KEYS = {
    "ewmaAlpha": (0.0, 1.0),
    "targetLatencyMs": (1, 600_000),
    "certWindow": (1, 10_000),
    "certCompletion": (0.0, 1.0),
    "certPass": (0.0, 1.0),
    "demotePass": (0.0, 1.0),
    "routing": None,
}
ROUTING_WEIGHTS = {"wPrior", "wPass", "wAvail", "wLat"}


def check_endpoints(endpoints: list, errors: list[str]) -> None:
    if not endpoints:
        errors.append("modelEndpoints must declare at least 1 endpoint")
        return
    for i, ep in enumerate(endpoints):
        where = f"modelEndpoints[{i}]"
        if not isinstance(ep, dict):
            errors.append(f"{where} must be an object")
            continue
        for key, expected in ENDPOINT_REQUIRED.items():
            if key not in ep:
                errors.append(f"{where} missing field: {key}")
            elif not isinstance(ep[key], expected):
                errors.append(f"{where}.{key} must be {expected.__name__}")
        for key, expected in ENDPOINT_OPTIONAL.items():
            if key in ep and not isinstance(ep[key], expected):
                errors.append(f"{where}.{key} must be {expected.__name__}")
        for cls, value in ep.get("priors", {}).items() if isinstance(ep.get("priors"), dict) else []:
            if cls not in PRIOR_CLASSES:
                errors.append(f"{where}.priors has unknown class: {cls}")
            elif not isinstance(value, (int, float)) or not 0 <= value <= 1:
                errors.append(f"{where}.priors.{cls} must be a number in [0, 1]")


def check_tuning(tuning: object, errors: list[str]) -> None:
    if not isinstance(tuning, dict):
        errors.append("tuning must be an object")
        return
    for key, value in tuning.items():
        if key not in TUNING_KEYS:
            errors.append(f"tuning has unknown key: {key}")
        elif key == "routing":
            if not isinstance(value, dict):
                errors.append("tuning.routing must be an object")
                continue
            for cls, weights in value.items():
                if cls not in PRIOR_CLASSES:
                    errors.append(f"tuning.routing has unknown class: {cls}")
                elif not isinstance(weights, dict) or set(weights) != ROUTING_WEIGHTS:
                    errors.append(
                        f"tuning.routing.{cls} must define exactly {sorted(ROUTING_WEIGHTS)}"
                    )
        else:
            low, high = TUNING_KEYS[key]
            if not isinstance(value, (int, float)) or not low <= value <= high:
                errors.append(f"tuning.{key} must be a number in [{low}, {high}]")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: validate_task.py path/to/task-manifest.json", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))

    errors: list[str] = []
    warnings: list[str] = []

    if "modelAdapter" in data:
        errors.append("modelAdapter was replaced by modelEndpoints in schema v2")

    for key, expected_type in REQUIRED_FIELDS.items():
        if key not in data:
            errors.append(f"missing field: {key}")
        elif not isinstance(data[key], expected_type):
            errors.append(f"wrong type for {key}: expected {expected_type.__name__}")

    if isinstance(data.get("maxTurns"), int) and data["maxTurns"] < 1:
        errors.append("maxTurns must be at least 1")

    if "taskStatement" in data and not isinstance(data["taskStatement"], str):
        errors.append("taskStatement must be a string")

    if isinstance(data.get("modelEndpoints"), list):
        check_endpoints(data["modelEndpoints"], errors)
        if not errors and len(data["modelEndpoints"]) < 3:
            warnings.append(
                "fewer than 3 endpoints: HA and reasoning-based routing degrade "
                "to health-gating (docs/DEFINITIONS.md §3.3)"
            )

    if "tuning" in data:
        check_tuning(data["tuning"], errors)

    if errors:
        print("TASK_INVALID")
        for error in errors:
            print(f"- {error}")
        return 1

    print("TASK_OK")
    for warning in warnings:
        print(f"! {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
