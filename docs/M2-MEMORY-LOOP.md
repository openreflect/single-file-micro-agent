# M2 — Git-Backed Tiered Memory Build Loop

Working directory: `/home/alice/workbench/openreflect/single-file-micro-agent`

## What this loop builds

SPEC §6 — *tiered, type-agnostic, self-profiling memory* — is the largest
specified-but-unbuilt subsystem. Today only `.sfma/memory.json` exists (run
history, pinned configuration, endpoint profiles: DEFINITIONS §7).

**The substrate is git.** Not a bolt-on: git's object store and commit DAG
already are the thing SPEC §6 describes, and using them deletes whole
categories of code we would otherwise write badly.

| SPEC §6 need | Git primitive | Why it is the right answer |
|---|---|---|
| Referential recall | `git cat-file -p <sha>` | Content-addressed; no index to maintain or corrupt |
| Episodic recall | `git log --since/--until`, parent links | The DAG *is* the time-ordered index, with causality |
| Lexical search | `git grep <pat> $(git rev-list --all)` | Searches all history, not just the working tree |
| Change-point recall | `git log -S<string>` (pickaxe) | "When did this fact enter or leave memory?" — a mode the spec never had |
| Reference discipline | the SHA | A pointer *is* the natural shape of the data; the binding rule stops needing enforcement |
| Tamper-evidence | object hashing | Memory inherits the trace's verification story; signable with the same Ed25519 path |
| Dedup / compaction | `git gc`, packfiles | Free |
| Annotating immutable memory | `git notes` | Epsilon can score a record without rewriting history |

What git does **not** give: semantic similarity. `git grep` is lexical, so
the "degrade loudly" rule (M2.6) still stands — it just degrades to something
far better than token overlap.

The agent reaches git **through the existing containment floor** as an
allowlisted command inside the sandbox. Memory therefore becomes an
application of the floor, not a hole in it.

## Non-negotiables — violating any of these fails the iteration

1. `agent.mjs` stays **one file with zero package dependencies** (`node:`
   builtins only). Helper *surfaces* may live in `scripts/`; engine logic
   may not.
2. **The containment floor may be extended, never weakened.** M2.1 adds a
   git subcommand gate — that is the one sanctioned floor change in this
   loop. `resolveIn()`, `outputPath()`, budget enforcement, the namespace
   sandbox, and the trace hash-chain keep their current behavior, and every
   existing floor test keeps passing unmodified.
3. All new tests are **offline and keyless** (mock provider, local git repos
   in temp dirs) so CI stays green with no credentials.
4. Every iteration ends green: `python3 tests/test_m0.py` fully passes
   *before* committing.
5. **Never weaken an existing test** to make new code pass.
6. Memory lives **inside the workspace**, under `.sfma/` only.
7. No new runtime prerequisites beyond what `SECURITY.md` declares — and git
   becoming a *memory* prerequisite must be added to `SECURITY.md` in M2.7,
   with graceful degradation when git is absent (fall back to the existing
   `memory.json` behavior; never fail the run).
8. Trace `kinds` in DEFINITIONS §1 are declared exhaustive — adding a kind
   means updating that list in the same commit.

## Progress ledger

There is no separate tracker: **`git log --oneline -15` is the state.** Each
milestone lands as exactly one commit whose subject begins
`feat(memory): M2.N`. Start every iteration by running that command, then
work the lowest-numbered milestone not yet present.

## Milestones

**M2.1 — Git subcommand gate (floor first, before git is ever runnable)**
The manifest allowlists *executables*, not subcommands, and git is an
enormous surface that includes network egress. Before any memory code
exists, extend `checkCmd()` so an allowlisted `git` is constrained to a
local, non-network subcommand set (`init`, `add`, `commit`, `cat-file`,
`rev-parse`, `rev-list`, `log`, `grep`, `show`, `notes`, `gc`). Refuse
fail-closed: `fetch`, `push`, `clone`, `remote`, `submodule`, and anything
unlisted. Also refuse argument-level escapes regardless of subcommand —
`-c`, `--exec-path`, `--upload-pack`, `--receive-pack`, `--config-env`,
`-C`, and any `--git-dir`/`--work-tree` pointing outside the workspace.
Every refusal is a hard-tier verdict in the trace. Tests: one case per
denied subcommand and per argument escape.

**M2.2 — Git-backed long tier**
Initialize a memory repo at `.sfma/mem/`, with hard guards: it must resolve
inside the workspace, must not be a symlink, and the run **aborts** if it
resolves into any repository containing `agent.mjs` — an agent that can
commit into its own source tree is precisely the self-modification path
SPEC §3 gates behind an observer that does not exist yet. One commit per
run at exit carrying that run's memory delta (matching the bounded-run-chain
model). Profile the store with a timed canary write+read; record
`latencyMs`, reachability, and detected capabilities under `stores` in
`memory.json` and emit a new `store` trace kind. Profiles are re-measured
every run — live, not one-time. If git is unavailable, log it, degrade to
today's `memory.json` behavior, and continue.

**M2.3 — Tier placement and reference discipline**
Place stores by *measured* latency: in-process fast, workspace files medium,
git long (deterministic tie-break by name; a single available store fills
all tiers and that fact is traced). Enforce SPEC §6's binding rule in code —
a fast-tier write whose payload exceeds `tuning.fastTierMaxBytes` (default
512) is refused, traced, and stored in a slower tier with only the pointer
kept fast. Where the slow tier is git, that pointer is the blob SHA.

**M2.4 — Recall tool: referential, episodic, lexical**
New tool `{"tool":"recall","mode":...}` mapping to the primitives above:
`referential` (by SHA or id, searching fast→slow, returning which tier hit),
`episodic` (a `seq`/time window over the DAG and the §4 ordering log — read
the existing trace as the episodic index, do not duplicate it), and
`lexical` (`git grep` across history). Results capped and clipped like any
tool result; every recall traced. Prove cross-run persistence with a two-run
test: run A writes, run B recalls.

**M2.5 — Change-point recall (new mode)**
Add `mode:"change"` over `git log -S` — *when did this fact enter or leave
memory, and in which run?* This is a capability the spec never had; amend
SPEC §6 to list four recall modes rather than three, and say plainly that it
exists because the substrate offers it.

**M2.6 — Semantic as a measured capability**
Probe whether any configured store or endpoint actually supports similarity
search. If yes, use it. If no, `mode:"semantic"` **degrades loudly**: return
a clearly labelled `git grep` lexical ranking with `degraded: true` in both
the tool result and the trace. Never silently imply a capability exists —
SPEC §6 says capability, not assumption.

**M2.7 — Docs, security ledger, and evidence**
Update SPEC §6 (git substrate, fourth recall mode), DEFINITIONS (manifest
fields, `store` trace kind, tuning defaults, tier rules, recall modes),
**SECURITY.md** (the git subcommand gate as an enforced claim, and git's
status as an optional memory prerequisite with its degradation path),
README feature tree, and a short ONBOARDING subsection. Then run a live
two-run chain proving cross-run recall — use the Codex OAuth helper if
credentials are present; if none are, say so plainly rather than claiming a
live result.

## Per-iteration procedure

1. `git log --oneline -15` → identify the lowest missing milestone.
2. Re-read the relevant SPEC/DEFINITIONS/SECURITY section before writing code.
3. Implement the **smallest complete** version of that milestone.
4. Add its tests; run the whole suite.
5. Green → commit `feat(memory): M2.N — <what>` with the standard
   `Co-Authored-By` and `Claude-Session` trailers, then push.
6. Red after two honest repair attempts → commit nothing and report the
   blocker.
7. When M2.7 is committed and the suite is green, **stop the loop**
   (`ScheduleWakeup` with `stop: true`).

## Reporting

End each iteration with: milestone completed, what changed in one paragraph,
test count before → after, and the next milestone. No file dumps.

## Scope discipline

Build only what the milestones name. If something else looks broken or
tempting, note it in the iteration report — do not fix it in this loop.
