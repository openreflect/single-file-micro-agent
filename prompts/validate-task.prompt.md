# validate_task.py Prompt

## Intent

Validate that a Single File Micro Agent task manifest declares the minimum fields needed for a bounded autonomous run.

## Inputs

- Path to a JSON task manifest.

## Preconditions

- The manifest is synthetic or public-safe.
- The validator must not execute commands.
- The validator must not call a model API.

## Verification

- Return `TASK_OK` when required fields and types are present.
- Return `TASK_INVALID` plus actionable field errors otherwise.

## What not to do

- Do not run the task.
- Do not infer missing permissions.
- Do not read private credentials or environment-specific config.
