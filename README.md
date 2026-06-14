# Single File Micro Agent

Single File Micro Agent is a tiny, API-agnostic framework for running disposable autonomous agents in tightly bounded workspaces. It is designed for simple tasks where a full agent platform would add more surface area than the task needs.

The core idea is to keep the harness small enough to inspect, restrict what the agent can touch, and make every run produce a durable result record.

## Why it exists

Many agent tasks need a worker, not a platform. A small autonomous loop can review a file, transform a fixture, run a command, or produce a short report if the environment boundary is clear.

This project captures the reusable public pattern for a minimal sandboxed agent runner while leaving private model routing, credentials, and live operational policy in downstream repos.

## Core idea

```text
task manifest
     |
     v
single-file micro-agent runner
     |
     +--> bounded workspace
     +--> model/API adapter
     +--> deterministic tool policy
     +--> result record
```

The runner should be boring by design: small manifests, clear permissions, synthetic fixtures, and explicit outputs.

## What Single File Micro Agent manages

- Task manifests.
- Workspace boundaries.
- Allowed command policy.
- Model/API adapter shape.
- Result records.
- Public-safe fixture runs.

## Design principles

- One task, one bounded workspace, one result record.
- Keep the runner API-agnostic.
- Default to dry-run and synthetic fixtures in public examples.
- Make command permissions explicit.
- Prefer recoverable outputs over hidden side effects.

## Repository layout

```text
.
├── README.md
├── PRD.md
├── docs/
├── examples/
│   └── task-manifest.example.json
├── prompts/
│   └── validate-task.prompt.md
├── scripts/
│   └── validate_task.py
└── tests/
```

## Current status

This is an initial public-safe project workspace. It contains the intended repository shape, a synthetic task manifest, and a deterministic task-manifest validator.

Run the public-safe check:

```bash
python3 scripts/validate_task.py examples/task-manifest.example.json
```

## Public/private model

Use this repository as the generic upstream. Keep private model keys, local runtime paths, live task logs, and environment-specific command policies in private downstream repositories or private branches.

```text
ORG/single-file-micro-agent public generic framework
private downstream fork      local adapters, credentials, task logs
```
