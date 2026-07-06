# Definitions — Trace, Result Record, Endpoint Grid

Normative companion to [SPEC.md](../SPEC.md) §4, §5.6, §5.7, §8. Minimal by
intent: fields not listed here are not part of the contract. All tunables live
in the manifest's optional `tuning` block; the defaults below are the chosen
first-run values and apply when `tuning` is absent.

## 1. Trace entry

The trace is an append-only JSONL log — the medium's durable form. One entry
per event. Entries are never edited or deleted; corrections are new entries.

| Field | Type | Meaning |
|-------|------|---------|
| `seq` | int | Monotonic clock reading (ns) at write — total order (§4.1) |
| `anchor` | string | ID of the most recent NTP re-anchor entry (§4.2) |
| `loop` | int | Writing loop index; `0` = the runner floor itself |
| `kind` | string | One of the kinds below |
| `id` | string | This entry's stable reference (`kind-seq`) |
| `refs` | string[] | IDs this entry responds to or depends on (may be empty) |
| `class` | string? | `reasoning` or `mechanical` — present on model-call kinds |
| `data` | object | Kind-specific payload, or `{ptr: <tier-ref>}` when the payload lives in a slower tier (reference discipline, §6) |

**Kinds** (exhaustive): `task`, `result`, `verdict` (epsilon judgment:
`{tier: "hard"|"soft", pass: bool, reason}`), `mutation` (self-modification:
`{surface, before-ptr, after-ptr}`), `weight` (grid snapshot), `lifecycle`
(`{from, to}` per §5.6 states), `clarification` (§5.5), `candidate` (bootstrap
draft), `clock-anchor` (NTP result), `call` (model API request/response
metadata: endpoint, class, latencyMs, ok).

## 2. Result record

One JSON document per run, assembled by the floor at exit (any exit path).

| Field | Meaning |
|-------|---------|
| `manifest` | The manifest as run, including applied clarifications |
| `genesisVersion` | e.g. `genesis-v1` |
| `bootstrap` | Winning candidate verbatim + `refs` to all losing candidates |
| `lifecycle` | Ordered `lifecycle` entries: probation → certified/demoted |
| `outputs` | Declared outputs actually produced, with hashes |
| `criteria` | Each successCriterion with final pass/fail and evidence `refs` |
| `weights` | Final endpoint grid + count of `weight` snapshots in trace |
| `mutations` | Count and `refs` of all self-modifications |
| `clock` | First/last `seq`, all anchor points |
| `trace` | Path/pointer to the full JSONL trace |
| `verdict` | `completed` \| `failed` \| `halted-maxTurns` \| `halted-budget` \| `halted-operator` |

## 3. Endpoint grid

### 3.1 Endpoints

Configured in the manifest (`modelEndpoints`, 1..n entries; 3 is the target —
OpenAI, Gemini, Anthropic — 1 is a supported degenerate mode). Per endpoint:
`name`, `provider`, `model`, optional `baseUrl`, optional `priors`
(`{reasoning: 0..1, mechanical: 0..1}`, benchmark-derived; default `0.5`),
optional `auth`.

**Auth.** Default is a provider API key from env (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`). An endpoint may instead declare
machine OAuth:

```json
"auth": {
  "type": "oauth2-client-credentials",
  "tokenUrl": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token",
  "clientIdEnv": "AZ_OPENAI_CLIENT_ID",
  "clientSecretEnv": "AZ_OPENAI_CLIENT_SECRET",
  "scope": "https://cognitiveservices.azure.com/.default"
}
```

Tokens are fetched, cached per endpoint, and refreshed 60s before expiry; a
token failure counts as an endpoint transport failure (failover applies). The
manifest names env variables, never secret values (SPEC §10). Interactive
OAuth flows (browser sign-in) are deliberately unsupported *inside the file*:
an autonomous run cannot block on a human. The example above pairs with
`baseUrl: "https://<resource>.openai.azure.com/openai"` for Azure OpenAI's
v1-compatible route; any OAuth2-fronted gateway works the same way.

**ChatGPT-plan OAuth (`provider: "codex"`).** Rides an existing ChatGPT
subscription login (as provisioned by `codex login` or OpenClaw) instead of a
platform API key. The credential helper
[scripts/codex_env.mjs](../scripts/codex_env.mjs) reads `~/.codex/auth.json`,
refreshes the access token when near expiry, and hands the agent
`OPENAI_CODEX_TOKEN` / `OPENAI_CODEX_ACCOUNT`:

```bash
node scripts/codex_env.mjs -- node agent.mjs manifest.json --apply
```

The endpoint entry is just `{"name": "openai-codex", "provider": "codex",
"model": "gpt-5.5"}`. Caveat, stated plainly: this backend
(`chatgpt.com/backend-api/codex`, Responses API over SSE) is an unofficial
surface tied to the account's plan — it can change without notice, so treat
it as one endpoint in the grid, never the only one, for anything that must be
stable.

### 3.2 Measured state (EWMA, α = `tuning.ewmaAlpha`, default **0.3**)

Per endpoint, updated from each `call` trace:

- `latencyMs` — EWMA of observed call latency
- `availability` — EWMA of transport success (1 ok / 0 fail)
- `passRate[class]` — EWMA of epsilon soft-tier verdicts on work this
  endpoint produced, kept per class

### 3.3 Score (reasoning-based routing)

For a call of class *c*:

```
score(e, c) = wPrior·priors[c] + wPass·passRate[c] + wAvail·availability
            + wLat·min(1, tuning.targetLatencyMs / latencyMs)
```

Default weight vectors (`tuning.routing`), chosen for first run:

| class | wPrior | wPass | wAvail | wLat |
|------------|--------|-------|--------|------|
| reasoning | 0.20 | 0.50 | 0.20 | 0.10 |
| mechanical | 0.10 | 0.30 | 0.20 | 0.40 |

`targetLatencyMs` default: **4000**.

Selection: highest score wins; on transport failure fall through to
next-ranked (HA). An endpoint is **down** after 3 consecutive transport
failures; retried with backoff 30s, doubling, cap 10min. With one endpoint
configured, scoring is bypassed and only health-gating applies. Loops may
propose weight-vector adjustments as ordinary tasks; epsilon judges them like
any other work (§5.7).

**Judge independence (SPEC §5.3):** a soft-tier judgment call excludes the
endpoint that produced the work under judgment whenever another endpoint is
usable — no endpoint approves its own output.

## 4. Certification statistics (§5.6)

Computed deterministically over the trailing window
`tuning.certWindow` = **20** completed soft-tier judgments:

- **Certify** when all hold: completion rate ≥ `tuning.certCompletion`
  (**0.90**), soft-tier pass rate ≥ `tuning.certPass` (**0.85**), hard-tier
  violations = **0** (not tunable).
- **Demote** a pinned configuration when: any hard-tier violation (immediate),
  or soft-tier pass rate over the window < `tuning.demotePass` (**0.60**).

All thresholds except the hard-tier zero are tunable via `tuning`. The
computation is pure code over `verdict` entries — no model call, no operator
judgment.

## 5. Manifest v2 delta

`modelAdapter` (string) is **replaced** by `modelEndpoints` (array, §3.1).
New optional field `tuning` (object) holds: `ewmaAlpha`, `targetLatencyMs`,
`routing` (per-class weight vectors), `certWindow`, `certCompletion`,
`certPass`, `demotePass`. Unknown `tuning` keys are a validation error.
All other v1 fields are unchanged.

## 6. Resource budget (the arithmetic backstop, SPEC §5.3/§8)

Optional manifest fields, enforced by pure code on every cycle; exceeding any
halts the run with verdict `halted-budget`. Defaults apply when absent:

| Field | Default | Range |
|-------|---------|-------|
| `maxModelCalls` | `maxTurns × 8` | 1..100000 (counts every attempt, failovers included) |
| `maxSeconds` | **900** | 1..86400 (wall clock) |
| `maxLoops` | **3** (M0 runs 1) | 1..16 |
| `maxPendingTasks` | **32** | 1..4096 |
| `allowSelfModification` | **false** | bool — code mutation additionally requires a detected observer (SPEC §3) |

Operator halt: SIGINT/SIGTERM to the process, or creating `.sfma/HALT` inside
the workspace, drains the run and records verdict `halted-operator`. The
trace records which gate fired and why.

## 7. Cross-run memory (`.sfma/memory.json`)

The long-term tier at M0.5 scale: one JSON file per workspace, read at
startup (recall) and updated at exit. Extended autonomy is a **chain of
bounded runs** — `scripts/run_chain.mjs` relays them; memory carries what was
learned between them.

| Field | Meaning |
|-------|---------|
| `runs` | Trailing run summaries (verdict, turns, modelCalls, hardTierFailures, dryRun); capped at 100 |
| `pinned` | Certified bootstrap candidate + genesis version, or `null` |
| `endpoints` | Lifetime endpoint profiles (calls, failures, latency EWMA) — seeds the grid on the next run |

**Recall:** endpoint profiles seed routing; if `pinned` exists (and matches
the current genesis version), the run **replays** the certified configuration
— lifecycle starts at `pinned-replay`, bootstrap drafting is skipped, and the
first model call is work, not drafting.

**Live scoring (shipped):** routing now computes the §3.3 score for real —
priors + measured pass rate, availability EWMA, and latency EWMA, with
3-consecutive-failure down detection and 30s→10min backoff. Because
endpoint profiles persist in memory, the grid's self-chosen distribution
across providers carries over between runs and keeps tuning for the life of
the workspace.

**Certification:** computed by pure code over the trailing `certWindow`
(default 20) non-dry runs — certify and pin when the window is full,
completion rate ≥ `certCompletion` (0.90), and hard-tier violations are zero
across the window. A run only counts as `completed` if it also passed the
soft tier (§8), so certification now certifies work quality, not just rule
compliance. **Demotion:** any hard-tier violation in a pinned run demotes
immediately; completion rate below `demotePass` (0.60) over the window also
demotes. Demoted workspaces re-emerge from probation on the next run. Dry
runs are recorded but excluded from certification statistics. Every
transition is a `lifecycle` trace and appears in the result record.

## 8. Soft tier — the independent quality judge

After a run finishes clean on the hard tier (done, outputs produced, zero
violations, not dry), epsilon's soft tier judges the work against the
bootstrap's `successCriteria`: one `reasoning`-class model call given the
task statement, the criteria, and the produced outputs (clipped), returning
per-criterion pass/fail with evidence. **Judge independence:** the call
excludes the endpoint that produced the work whenever another endpoint is
usable. A soft-tier fail fails the run; judge *unavailability* does not —
criteria stay `null` and the record says `softTier: "unavailable"`. Verdicts
land as `verdict` traces (`tier: "soft"`), feed the endpoint `passRate`
EWMAs, and set `softPass` on the run's memory entry.

## 9. Health report (`.sfma/health.md`)

Rewritten after every run by pure code over recorded history: status
(PINNED/PROBATION), window and lifetime completion and soft-pass rates,
hard-tier violation counts, model-call totals, a per-endpoint table (calls,
fail%, latency, availability, pass rate), and the last five runs. The
one-page answer to "how has this been going?" for unattended chains.

## 10. Clock anchoring (`SFMA_NTP`)

Anchors default to the system wall clock, honestly labeled `system-wall`.
Set `SFMA_NTP=1` (pool.ntp.org) or `SFMA_NTP=host[:port]` to anchor the
trace against SNTP at run start and end — anchor entries then carry
`source: "ntp:<host>"` and the measured `offsetMs`. Any NTP failure falls
back to `system-wall(ntp-failed)` within 1.5s; the run never blocks on time.
