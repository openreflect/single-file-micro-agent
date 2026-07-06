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

## Feature tree

Section references (§) point into [SPEC.md](SPEC.md), the full architecture.

```text
single-file-micro-agent
├── Containment contract (§8)                        [partially shipped]
│   ├── Task manifest schema                          [shipped: example fixture]
│   ├── Manifest validator                            [shipped: validate_task.py]
│   ├── Co-developed disambiguation (§5.5)            [specified]
│   │   └── Restriction-only clarifications, operator-gated expansion
│   ├── Resource budget floor (§5.3/§8)               [shipped: pre-M1 gates]
│   │   ├── maxModelCalls · maxSeconds · maxLoops · maxPendingTasks
│   │   └── Operator halt: SIGINT/SIGTERM or .sfma/HALT → halted-operator
│   └── Result record                                 [shipped: M0]
│       ├── Emergent configuration capture
│       ├── Re-anchored event ordering
│       ├── Lifecycle transitions + mutation traces
│       └── Endpoint weight snapshots
├── Decision core — the flywheel (§5)                 [M0: single-loop floor shipped]
│   ├── Genesis prompt                                [drafted: prompts/genesis.prompt.md]
│   ├── Bootstrap → emergent configuration (§5.4)
│   ├── Worker loops (≥3, async, dynamic)
│   │   └── Each loop = instantiated LLM conversation
│   ├── Epsilon — replicated governor (§5.3)
│   │   ├── Hard tier: deterministic manifest floor (immutable)
│   │   └── Soft tier: mission adherence, 1..N model calls
│   ├── Configuration lifecycle (§5.6)                [shipped: run-level pinning]
│   │   └── Probation → statistical certification → pinning → demotion
│   └── Endpoint weight grid (§5.7)
│       ├── ≥3 LLM API endpoints, self-determined weights
│       └── Trace-to-weight: benchmark priors + measured latency/availability/pass-fail
├── Memory & communication (§6)                       [M0.5: cross-run memory shipped]
│   ├── Cross-run memory — recall + pinning (.sfma/memory.json)
│   ├── Blackboard medium — the only inter-loop channel
│   ├── Tiers placed by measured latency (short / medium / long)
│   ├── Reference discipline (fast tier = pointers only)
│   └── Recall modes: referential · semantic · episodic
├── Clocking (§4)                                     [M0: monotonic log shipped; NTP pending]
│   ├── Monotonic ordering log (doubles as episodic index)
│   └── Scheduled NTP re-anchor
├── Runtime (§3)                                      [shipped: agent.mjs]
│   ├── Single non-compiled file, JIT-class runtime
│   └── Self-modification: mutable policy / immutable floor
├── Observability (§7)                                [external, out of scope]
│   └── Invariant: no unobserved path to model, tools, or memory
└── Public/private split (§10)
    └── Public generic upstream · private forks hold keys, logs, observer
```

M0 is shipped: [agent.mjs](agent.mjs) (321 lines, Node ≥ 18 or Deno, zero
dependencies) runs a single loop under the full containment floor — manifest
enforcement, dry-run, append-only trace, result record — verified offline by
[tests/test_m0.py](tests/test_m0.py) via the deterministic mock provider.
Multi-loop bootstrap, epsilon soft tier, lifecycle, and the live weight grid
are M1+.

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
├── SPEC.md
├── agent.mjs                  # the single file — M0 runner
├── docs/
│   ├── DEFINITIONS.md
│   └── ONBOARDING.md
├── examples/
│   ├── task-manifest.example.json
│   └── workspaces/summarize-fixture/
├── prompts/
│   ├── genesis.prompt.md
│   └── validate-task.prompt.md
├── scripts/
│   └── validate_task.py
└── tests/
    └── test_m0.py
```

## Current status

The M0 containment-floor runner is shipped. New here? Follow
[docs/ONBOARDING.md](docs/ONBOARDING.md) — auth modes (API keys, ChatGPT-plan
OAuth, OAuth2 client-credentials), verification steps, and where run records
land. Public-safe checks, all offline:

```bash
python3 scripts/validate_task.py examples/task-manifest.example.json
python3 tests/test_m0.py                        # floor tests via mock provider
```

Run a task (dry-run is the default; `--apply` executes for real; providers
read `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` from the
environment):

```bash
node agent.mjs path/to/manifest.json
node agent.mjs path/to/manifest.json --apply --task="what to do"
```

Every run writes `.sfma/trace.jsonl` (append-only event log) and
`.sfma/result.json` (the result record) inside the workspace, and maintains
`.sfma/memory.json` — cross-run memory that certifies and pins proven
configurations over repeated runs.

Run continuously (a relay of bounded runs — each under its own budget and
audit record; stop any time with Ctrl-C or `touch <workspace>/.sfma/HALT`):

```bash
node scripts/run_chain.mjs path/to/manifest.json --every=300 --apply
```

## Public/private model

Use this repository as the generic upstream. Keep private model keys, local runtime paths, live task logs, and environment-specific command policies in private downstream repositories or private branches.

```text
openreflect/single-file-micro-agent  public generic framework
private downstream fork              local adapters, credentials, task logs
```
