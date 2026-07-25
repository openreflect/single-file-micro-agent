# Single File Micro Agent

[![CI](https://github.com/openreflect/single-file-micro-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/openreflect/single-file-micro-agent/actions/workflows/ci.yml)

> **Others build agents you have to trust — this is the agent you can verify.**

1. **Enforcement is code, not prompts.** Model-requested writes are limited to
   declared outputs; commands are allowlisted and execute fail-closed in an
   isolated Linux namespace with declared inputs only, no inherited secrets,
   and no host network. These controls live below the model.
2. **Work is contracted, not requested.** A task is a hash-bound, validatable
   manifest with declared inputs, outputs, and ceilings — "what is the agent
   allowed to do" is a reviewable document, not a vibe.
3. **Every run produces verifiable evidence.** The hash-chained trace and
   result commitments detect edits and bind the run to its manifest. Optional
   Ed25519 signing makes the record independently authenticatable.
4. **It gets *more* deterministic with use.** Statistical certification and
   pinning mean a repeated task converges to a proven configuration and gets
   cheaper (measured live: 3 → 3 → 2 model calls). Most agents drift; this
   one settles.
5. **Small footprint.** The agent remains one dependency-free file with no
   daemon. Model/read/write/dry-run behavior needs Node ≥ 18 or Deno; secure
   applied command execution additionally needs Linux namespace utilities.
6. **Autonomy with a human ignition key.** It runs persistently and
   unattended, yet cannot self-task, and chat can only narrow its work —
   persistent autonomy *without* open-ended agency.
7. **Built to be delegated to.** File-based mailbox and memory mean any
   platform (OpenClaw, Hermes, a Slack bot, cron) becomes its UI or
   dispatcher with zero integration — the bounded executor in everyone
   else's stack, not another competing brain.

Single File Micro Agent is a tiny, API-agnostic framework for running disposable autonomous agents in tightly bounded workspaces. It is designed for simple tasks where a full agent platform would add more surface area than the task needs. The exact enforced claims and remaining boundaries are in [SECURITY.md](SECURITY.md).

The core idea is to keep the harness small enough to inspect, restrict what the agent can touch, and make every run produce a durable result record.

## Why it exists

Many agent tasks need a worker, not a platform. A small autonomous loop can review a file, transform a fixture, run a command, or produce a short report if the environment boundary is clear.

This project captures the reusable public pattern for a minimal contained agent runner while leaving private model routing, credentials, and live operational policy in downstream repos.

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
├── Memory & communication (§6)                       [M2: git-backed memory shipped]
│   ├── Cross-run memory — recall + pinning (.sfma/memory.json)
│   ├── Operator mailbox — inbox/outbox chat (§5.5)   [shipped: notify/ask]
│   ├── Git substrate — one commit per run (.sfma/mem) [shipped: M2.2]
│   ├── Tiers placed by measured latency               [shipped: M2.3]
│   ├── Reference discipline (fast tier = pointers only) [shipped: enforced in code]
│   ├── Recall: referential · episodic · lexical · change [shipped: M2.4/M2.5]
│   ├── Semantic — degrades loudly, no store claims it [shipped: M2.6]
│   └── Blackboard medium — the only inter-loop channel [M1+]
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

M0 is shipped: [agent.mjs](agent.mjs) (Node ≥ 18 or Deno, zero package
dependencies) runs a single loop under the containment floor — manifest
enforcement, dry-run, hash-chained trace, result record — verified offline by
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
├── SECURITY.md                # enforced claim ledger + honest boundaries
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
│   ├── validate_task.py
│   └── verify_audit.mjs
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

Memory is **git-backed** (`.sfma/mem`, one commit per run), because git
already is what SPEC §6 describes: content-addressed objects give
referential recall, the commit DAG gives episodic recall with real causality,
`git grep` searches all history, and the pickaxe answers *when did this fact
enter memory, and in which run?* A blob SHA is already a pointer, so the
fast-tier reference rule is the shape of the data rather than a rule needing
enforcement. Stores are placed into tiers by measured latency each run, and
no store claims semantic similarity it cannot do — `semantic` recall degrades
loudly to a labelled lexical ranking. Git is optional: without it the agent
falls back to file-backed memory and says so.

Verify the trace/result commitments (and Ed25519 signature when configured):

```bash
node scripts/verify_audit.mjs path/to/workspace
```

Run continuously (a relay of bounded runs — each under its own budget and
audit record; stop any time with Ctrl-C or `touch <workspace>/.sfma/HALT`):

```bash
node scripts/run_chain.mjs path/to/manifest.json --every=300 --apply
```

Chat with a running chain (asynchronous by design — the agent posts status
and questions to the outbox via `notify`/`ask` without ever blocking; your
replies land in the inbox and reach it on its next run):

```bash
node scripts/chat.mjs path/to/workspace              # terminal chat
node scripts/telegram_bridge.mjs path/to/workspace   # phone chat via a Telegram bot
```

The Telegram bridge needs `TELEGRAM_BOT_TOKEN` (from @BotFather) and
`TELEGRAM_CHAT_ID` (run once without it — discovery mode prints yours);
messages from any other chat are ignored.

## Public/private model

Use this repository as the generic upstream. Keep private model keys, local runtime paths, live task logs, and environment-specific command policies in private downstream repositories or private branches.

```text
openreflect/single-file-micro-agent  public generic framework
private downstream fork              local adapters, credentials, task logs
```

## License

[MIT](LICENSE)
