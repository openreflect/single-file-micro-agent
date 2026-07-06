# Single File Micro Agent — Specification

> Status: design spec. This document is normative for intent and architecture;
> it precedes the runner implementation, which is future scope in
> [PRD.md](PRD.md). Where this spec and the PRD disagree, the PRD's first-release
> scope wins for *what ships first*; this spec wins for *what it is growing
> toward*.

## 1. One-line definition

A single self-contained file that, when run on a host the operator controls and
is authorized to use, becomes a complete self-configuring agent — its own
decision loop, tool dispatch, and model/API client, with no IDE, platform, or
runtime framework beneath it. Its trustworthiness comes not from a
human-readable interior but from two external, verifiable controls: an
observable boundary (§7) and an explicit task-manifest contract (§8).

## 2. Design lineage and stance

The design lesson is drawn from **minimal Unix primitives** — tools in the
spirit of `netcat`: one small, dependency-free program that does a single thing,
carries no platform, and composes with everything else through simple, standard
interfaces (pipes, sockets, files). The goal here is the agent-shaped analogue
of that philosophy: a minimal, single-file building block you wire into a host
or workflow you own, rather than a heavyweight agent platform.

The topology is the **autonomous-worker pattern** familiar from ordinary
distributed task systems: a lightweight node that pulls work, decides locally,
and reports results, coordinating without a central authority. This project
collapses that shape to **n = 1** — the single node that is also its own
coordinator. Nothing about the pattern implies reaching systems the operator
does not own; it is a general coordination shape, used here entirely within an
authorized host.

**Opaque by optimization, not by concealment.** The interior is *deliberately
dense*: code is combined and minimized for the agent's own efficiency, not
shaped for human reading. This is an engineering choice, not a way to hide
behavior from oversight — because behavior is established at the boundary (§7),
not by reading the inside. Legible boundary, dense interior; never trade the
first for the second.

## 3. Language and runtime constraints

- **Non-compiled languages only.** The runtime *is* the file. A self-configuring
  agent that adapts its own running form needs a language it can read and
  reshape at runtime, which a compiled artifact cannot do to itself.
- **Ultimately fast and extensible.** "Non-compiled" must not mean "slow." This
  points at JIT-class runtimes (e.g. LuaJIT, V8/JS) rather than pure tree-walking
  interpreters, because the multi-loop cadence (§5) is throughput-sensitive.
- **Single-file discipline.** The entire agent — loops, dispatch, memory,
  clocking, API client — lives in one file. External dependencies are avoided;
  where the host provides a capability (clock, socket, storage), the agent
  enumerates and uses it rather than bundling its own.
- **Self-modification — mutable policy, immutable floor.** The agent may
  rewrite anything above the containment floor at runtime: loop topology,
  schedules, prompts, endpoint weights, memory placement, even its own dispatch
  code. The floor itself — epsilon's hard tier (§5.3), manifest enforcement
  (§8), and boundary I/O (§7) — is immutable for the life of a run. This is the
  application-delivery-controller discipline: policy is fluid, the enforcement
  engine is fixed. Every mutation is written through the medium (§5.2) as a
  clock-stamped trace (§4), never applied in the dark, so the result record can
  state what the agent's running form was at every point in the timeline.

## 4. Clocking — dual-clock model

Two clocks with strictly separated roles. They are never conflated.

### 4.1 High-resolution monotonic clock (record-keeping)

- A local **monotonic** counter read at the finest resolution the host exposes,
  conceptually to the **picosecond**.
- Its purpose is **response and event record-keeping**, not wall-clock truth.
  It establishes the exact *internal ordering* of loop events, decisions, model
  calls, and responses — a forensic ordering log that supports the audit trail.
- This makes no claim to picosecond wall-clock *accuracy*, which is physically
  unreachable over any clock network. It is a precise *ordering and duration*
  instrument, internal to the agent.
- The ordering log doubles as the **episodic index** of long-term memory (§6):
  time-anchored recall reads this record.

### 4.2 Reference clock (integrity re-anchor)

- The agent understands and references **official clock sources (NTP)**.
- Real-world time is verified only **on a set schedule**, not continuously. On
  each verification the monotonic ordering log is re-anchored to real time, so
  the record is both internally exact (ordering) and externally dateable (NTP).
- NTP delivers low-millisecond accuracy; that is sufficient because it only
  timestamps the *anchor points*, while intra-anchor ordering comes from §4.1.

## 5. Loops, epsilon, and the flywheel

The decision core is **LLM-driven end to end**: a set of **asynchronous worker
loops**, each an instantiated model conversation, governed by **epsilon**, a
lightweight judge replicated into every loop. This is the heart of the design.

### 5.1 Loops (workers)

- **Each loop is an instantiated LLM.** A loop is a live model conversation,
  instantiated from the bootstrap configuration (§5.4). The model's output
  drives the loop's tool dispatch, task creation, and scheduling decisions; the
  surrounding code is only transport, scheduling, and containment — it decides
  nothing.
- **Nothing is synchronous.** No loop blocks on another.
- **Minimum of 3 operating loops.** Three is the floor that tolerates one slow,
  failed, or dissenting member.
- Loops are **dynamic**: the agent builds and destroys loops at runtime as load
  and task shape demand. Three is a floor, not a fixed count. Building a loop
  means instantiating a new model conversation; destroying one means ending it
  and recording its outcome.
- Each loop is a **worker**: it creates tasks, defines schedules, and executes
  work — always inside the manifest boundary (§8).

### 5.2 The flywheel (steady state)

- Steady-state operation is a **flywheel**: loops define tasks and schedules
  whose outputs feed other loops, which generate further tasks in turn.
- **The medium is the memory (§6).** Loops never communicate directly; they
  read and write traces — tasks, results, verdicts, mutations — in the shared
  tiered memory, blackboard-style. The fast tier carries references only;
  payloads live in the slower tiers. Because every memory access crosses the
  observable boundary (§7) and memory is the only inter-loop channel, there is
  no unobserved path between loops: the flywheel's entire internal conversation
  is auditable by construction.
- A flywheel is a positive-feedback system. Ungoverned, it either runs away or
  spins down. **Epsilon is the governor** (§5.3); the manifest's `maxTurns` is
  the hard mechanical stop behind it.

### 5.3 Epsilon — the governor

Epsilon is **not** a random tie-breaker. It is the judgment function that
continuously decides whether work persists — the project's key function.

- **Replicated, not central.** Epsilon exists **as part of every loop**. There
  is no distinguished judge process; the judge is a function every loop
  carries.
- **Lightweight and two-tier:**
  - **Hard tier — deterministic core, anchored to the manifest.** Pure code, no
    model calls, identical in every loop, run on every judgment: is the task
    inside the declared `workspace`? Does it use only `allowedCommands`? Does
    it write only declared `outputs`? Is it within `maxTurns`? Identical code
    over identical inputs yields identical verdicts, so replicated epsilon
    instances cannot disagree at this tier.
  - **Soft tier — mission adherence, LLM-instantiated.** A **tunable number of
    model calls per judgment** (1..N, a budget knob: one call for routine
    judgments, more for contested or high-stakes ones) evaluating whether the
    work serves the mission as expressed in the bootstrap configuration (§5.4).
    Every persistence judgment includes at least one model call — the hard tier
    alone never constitutes a verdict; it is the containment floor beneath an
    LLM-driven judgment, not a substitute for it.
- **The hard tier is a floor.** The soft tier may kill work the hard tier
  passed; it may never revive work the hard tier failed.
- **Persistence is the verdict.** A task, schedule, or loop persists only while
  it passes epsilon. Disagreement between loops is resolved the same way: the
  contested work is judged, and it persists or it does not.

Because the hard tier is anchored to the human-authored manifest — not to
anything the agent generated — a badly-formed bootstrap can make a run *fail*,
but cannot make it *escape* the containment contract.

### 5.4 Bootstrap and emergent configuration

- Loops are instantiated from the **genesis prompt**
  ([prompts/genesis.prompt.md](prompts/genesis.prompt.md)) — the one fixed,
  versioned prompt baked into the file, sitting below the containment floor
  and auditable in this repo. All loops receive it identically; candidate
  diversity comes from sampling, not differentiated instructions.
- At startup the coordination unit is the **bootstrap prompt**. Loops
  independently draft candidates per the genesis prompt's contract; epsilon
  judges them (hard tier: consistency with the manifest; soft tier: coherence
  and fitness for the task), and the surviving candidate becomes the agent's
  operating configuration — including its system prompt and the
  `successCriteria` that drive probation (§5.6).
- The configuration is therefore **emergent**, and startup behavior is
  high-variance and not reproducible run to run. The emergent configuration
  MUST be captured into the result record (§8), so a run is *explainable after
  the fact* even though it is not deterministic.
- The quality of the bootstrap largely determines whether the run succeeds.
  Judging that — deciding whether the run's tasks can persist under the
  bootstrap as understood — is epsilon's job, not a separate mechanism.

### 5.5 Co-developed manifest (disambiguation)

- The manifest is human-authored ground truth, but it is **co-developed**:
  epsilon performs **disambiguity checking** against it. Where the manifest is
  ambiguous — vague outputs, unclear scope, commands of uncertain intent —
  epsilon seeks clarity rather than letting loops guess.
- Clarification is **restriction-only from the agent's side**: the agent may
  propose narrower readings, never wider ones. Any expansion of the workspace,
  command allowlist, or declared outputs requires the operator.
- Every clarification and its resolution is captured in the result record, so
  the manifest a run *actually* operated under is auditable.

### 5.6 Configuration lifecycle — probation to pinned

A fresh emergent configuration (§5.4) is not trusted; it earns trust
statistically.

- **Probation.** Every new configuration starts on probation: epsilon issues
  full run tracing and judges each cycle against the work criteria stated in
  the genesis prompt — does the work produced match what the user said the
  task is?
- **Certification is statistical, not judged.** A configuration is proven
  stable based on **statistical completion from the trace-to-weight process
  (§5.7)** — deterministic statistics computed over the trace record
  (completion rates, pass/fail counts, hard-tier violations) — not by arbitrary
  human judgment and not by a model's self-assessment. The same pipeline that
  weights endpoints weights configurations.
- **Pinning.** A certified configuration is pinned into long-term memory. A
  later run under the same manifest replays the pinned configuration instead of
  re-emerging, making repeatable tasks effectively deterministic once proven —
  learned repeatability.
- **Demotion.** Failures or drift under a pinned configuration demote it and
  return the run to probation and re-emergence — the same way a failed health
  check demotes a backend.
- All lifecycle transitions are captured in the result record (§8).

### 5.7 Model access — the endpoint weight grid

- The agent targets **3 LLM API endpoints** (reference set: Anthropic, OpenAI,
  Gemini), mirroring the loop floor: enough to tolerate one slow, failed, or
  degraded provider. **One endpoint is a supported degenerate mode** — the grid
  collapses to health-gating (down detection, backoff, retry) and routing is
  bypassed.
- Routing is **reasoning-based, not just HA**: every model call carries a task
  class (`reasoning` or `mechanical`), and each endpoint is scored per class —
  so a call needing judgment can route differently than a call needing speed.
  Failover falls through score order.
- Access is allocated by **self-determined weights** in an **evaluation grid
  that tunes continually as part of the flywheel**: loops vote weight
  adjustments as ordinary flywheel work, and epsilon judges those adjustments
  like any other task.
- Weighting criteria combine **priors** — published information such as
  benchmarks — with **measured evidence**: real-world latency, accessibility
  and availability, observed reasoning quality, and task-level pass/fail
  outcomes from the trace record.
- The **trace-to-weight process is deterministic**: weights are computed from
  recorded traces by code, so the grid is auditable and cannot be argued with.
  This same process supplies the stability statistics for configuration
  certification (§5.6).
- Formulas, defaults, and every tunable knob are defined in
  [docs/DEFINITIONS.md](docs/DEFINITIONS.md); defaults are the chosen first-run
  values and the manifest's `tuning` block overrides them.

## 6. Memory — tiered, type-agnostic, self-profiling

Persistent memory is **extensible** and treated **agnostically by type**: cache,
filesystem, and database are all just "memory," distinguished only by measured
behavior. Memory is also the flywheel's communication medium (§5.2): loops
coordinate exclusively through traces left here.

- **Understand, don't assume.** The agent reaches a memory store by understanding
  its interface — API, MCP, documentation, or direct enumeration — rather than
  by hard-coded assumptions about what the store is.
- **Measure and store capability.** For each store, **latency and capabilities
  are evaluated and stored, and continually re-evaluated.** A store's profile is
  live, not a one-time guess.
- **Tiered recall.** When more than one memory system is available, they are
  placed by measured speed:
  - **fast memory → short-term recall,**
  - **slower memory → medium-term recall,**
  - **slowest/most durable → long-term recall,**
  as the storage and memory system supports. Placement follows measured latency,
  not the store's nominal type.
- **Reference discipline (binding).** The fast tier carries references and
  minimal metadata only — payloads never live there. Working memory stays fast
  because it holds pointers into richer stores, not the stores' contents; a
  payload written to the fast tier degrades the bus into a slow log.
- **Three recall modes** for long-term memory, mirroring human recall:
  **referential** (explicit IDs and links), **semantic** (similarity search,
  where a store measurably supports it — a capability, not an assumption; absent
  it, the agent degrades gracefully to the other two), and **episodic**
  (time-anchored recall over the monotonic ordering log of §4, which doubles as
  the episodic index).

## 7. Observability — external by design

- **Observability is external to the agent** and is **out of scope for this
  effort** to build. The agent does not carry its own trusted introspection; the
  operator's environment provides it.
- Trust comes from the **boundary**. Every model API call, every tool
  invocation, and every memory access crosses an external interface. Whatever
  sits on that interface (a proxy, tap, or collector, supplied by the operator's
  environment) is where auditing happens.
- This is *why* the dense interior (§2) is acceptable: correctness was never
  established by reading the inside; it is established by observing the traffic.
  The agent cannot misreport what it never got to write, because the record is
  produced outside it.

### 7.1 The invariant that survives into scope

> **The agent has no unobserved path to the model, tools, or memory.**

Everything the agent does to affect the world crosses an observable channel. The
external observer is therefore **load-bearing to the design's integrity, not an
optional add-on**. Keep this invariant and the dense interior stays accountable
by construction. An agent that could reach the model, tools, or memory through
an unobserved path would violate this spec.

## 8. Containment contract (the manifest)

The public, safety-railed pattern already scaffolded in this repo is the
containment contract. It is what keeps a self-configuring, asynchronous agent a
*controllable worker* rather than an uncontrolled process. It is the legible
boundary around the dense interior, and it is mandatory.

Each run is governed by a **task manifest** declaring, at minimum (see
[scripts/validate_task.py](scripts/validate_task.py) and
[examples/task-manifest.example.json](examples/task-manifest.example.json)):

| Field | Meaning |
|-------|---------|
| `name` | Task identifier |
| `workspace` | The single bounded workspace the run may touch |
| `modelEndpoints` | 1..n provider-agnostic endpoints for the weight grid (§5.7); 3 is the target |
| `allowedCommands` | Explicit command allowlist — the only commands the run may execute |
| `inputs` / `outputs` | Declared input and output files |
| `maxTurns` | Upper bound on agent turns (≥ 1) |
| `dryRunDefault` | Default to dry-run; public examples use synthetic fixtures |
| `taskStatement` | *(optional)* Operator's stated work, fed verbatim to the genesis prompt |
| `tuning` | *(optional)* Overrides for routing weights, EWMA, and certification thresholds — [docs/DEFINITIONS.md](docs/DEFINITIONS.md) |

Schema v2 replaces v1's `modelAdapter` with `modelEndpoints`; the validator
rejects v1 manifests with a migration message.

The allowlist is exhaustive: a command not named in `allowedCommands` cannot be
run. The workspace is the only filesystem region a run may touch. These are
enforcement, not convention.

**Result record.** Every run produces a durable, auditable result record. For
this project that record MUST also capture the emergent configuration (§5.4),
the re-anchored event ordering (§4), configuration lifecycle transitions
(§5.6), self-modification traces (§3), and endpoint weight snapshots (§5.7), so
a non-deterministic run remains explainable.

## 9. Design principles (binding)

1. Run only on a host the operator owns and is authorized to use.
2. One task, one bounded workspace, one result record.
3. Keep the runner model/API-agnostic; providers are adapters.
4. Default to dry-run and synthetic fixtures in public examples.
5. Make command permissions explicit; infer nothing, allow nothing unnamed.
6. Prefer recoverable outputs over hidden side effects.
7. Nothing synchronous; loops do the work, epsilon judges what persists.
8. Minimize the *product's use surface*, not the code's density.
9. Legible boundary, dense interior — never trade the first for the second.
10. Mutable policy, immutable floor — self-modification never touches the
    enforcement surface.
11. Trust is earned statistically — configurations are certified by measured
    traces, not by judgment.

## 10. Public / private split

This repository is the **generic public upstream**: the reusable pattern,
synthetic fixtures, and containment contract only. Private model keys, live task
logs, local runtime paths, environment-specific command policy, and the external
observer stay in **private downstream forks or branches**.

```text
ORG/single-file-micro-agent   public generic framework, synthetic only
private downstream fork        adapters, credentials, task logs, observer
```

## 11. Impossibility boundaries (stated so they are never re-litigated)

- **Picosecond wall-clock accuracy is unreachable** over a clock network. §4
  uses picosecond resolution only for *internal ordering/record-keeping*; NTP
  re-anchors to real time on a schedule.
- **Leaderless deterministic async consensus is impossible** (FLP). §5 does not
  attempt it: **epsilon** is a replicated judge with a deterministic core, not a
  symmetry-breaking randomness source. Agreement at the hard tier comes from
  identical code over identical inputs; the soft tier tolerates disagreement
  because the decided question is persistence, not unanimity.
- **Emergent behavior is non-reproducible.** §5.4 accepts this for first
  contact and requires the emergent configuration be recorded, trading
  reproducibility for explainability. Repeatability is then *earned*, not
  assumed: §5.6 converges repeatable tasks onto pinned, statistically certified
  configurations.

## 12. Scope boundary for this effort

**In scope (this repo, over time):** the single-file runner, the loop/flywheel
core with its two-tier epsilon, the configuration lifecycle, the endpoint
weight grid, the dual-clock record, the tiered type-agnostic memory, the
manifest contract, the result record, and provider adapters.

**Out of scope (provided externally):** the observability layer (§7) and the
live operational policy, credentials, and model routing (§10).

## 13. Use boundary

This is a framework for **authorized, contained agent runs on systems the
operator owns**. It is not intended for, and its containment contract is
designed to prevent, use against systems the operator does not control:
unauthorized access, running commands outside the declared allowlist, touching
state outside the declared workspace, or any operation the observable boundary
cannot see. The rails in §7 and §8 exist precisely to keep the agent inside that
line.
