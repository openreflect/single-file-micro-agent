# Security claims and boundaries

This document is the claim ledger for the shipped runner. A claim is only
listed as enforced when the named mechanism and an adversarial test both exist.

## Enforced claims

| Claim | Enforcement | Verification |
|---|---|---|
| Model-requested file writes cannot target undeclared paths | `write` accepts exact manifest `outputs` only; `.sfma` is reserved | `test_undeclared_output_refused`, `test_workspace_escape_refused` |
| Model-requested commands cannot bypass the executable allowlist | shell metacharacters are refused; the runner discards model-supplied executable paths and resolves an allowed basename inside the sandbox | `test_disallowed_command_refused`, `test_shell_metacharacters_refused` |
| An allowed interpreter cannot read the host filesystem or undeclared workspace files | Linux user + mount + PID namespaces, a fresh chroot, read-only runtime mount, and a staged workspace containing declared inputs only | `test_allowed_interpreter_is_os_sandboxed` |
| A child command cannot inherit API keys or other runner secrets | child environment is rebuilt from an explicit non-secret minimum | `test_allowed_interpreter_is_os_sandboxed` |
| A child command cannot use the host network | every command receives a new network namespace with no host interface | `test_allowed_interpreter_is_os_sandboxed` |
| A child command can return only declared outputs | commands run against a disposable staging workspace; the runner rejects symlinks and copies back exact declared outputs only | `test_allowed_interpreter_is_os_sandboxed` |
| Turn, model-call, wall-clock, loop, and pending-task ceilings cannot be raised by model output | immutable manifest values are checked by runner code; the implemented M0 loop actively enforces turns, model calls, and wall time | budget tests; `maxLoops`/`maxPendingTasks` remain inert ceilings until those M1 features exist |
| An allowlisted `git` cannot reach the network or escape via arguments | `allowedCommands` gates executables, so git is additionally gated by subcommand: a local non-network set only (`init`, `add`, `commit`, `cat-file`, `rev-parse`, `rev-list`, `log`, `grep`, `show`, `notes`, `gc`); all pre-subcommand flags are refused (that position holds `-c`, `--exec-path`, `--config-env`, `--git-dir`, `--work-tree`), as are post-subcommand execution vectors (`--upload-pack`, `--receive-pack`, `--open-files-in-pager`, `-O`) | `test_git_gate_refuses_network_and_escape_arguments`, `test_git_gate_permits_local_subcommands` |
| The git memory store cannot write into an enclosing repository | `.sfma/mem/.git` must be a real directory and `--absolute-git-dir` must resolve inside it; a `.git` *file* pointing elsewhere aborts the run, as does a store resolving into a repository containing `agent.mjs` | `test_memory_store_refuses_enclosing_repository`, `test_memory_store_symlink_refused` |
| Trace edits, deletion, insertion, or reordering are detectable | each JSONL entry commits to the previous entry with SHA-256; an existing chain is verified before a run appends | `test_trace_tampering_is_detected_before_next_run` |
| A result is bound to the exact manifest, trace head/count, and result body | `.sfma/result.json` carries canonical SHA-256 commitments | `test_trace_is_ordered_and_anchored`, `scripts/verify_audit.mjs` |
| A third party can authenticate an audit produced by a configured operator key | optional Ed25519 signature over the integrity commitments, verified against an externally trusted public key | `test_ed25519_signed_audit_verifies`, `scripts/verify_audit.mjs` |

Git is an **optional** prerequisite, for memory only. With git present the
long tier is a repository at `.sfma/mem` receiving one commit per run; without
it the runner reports the store unavailable in the trace and continues on
file-backed memory, so a missing git degrades capability and never fails a
run. Git is only ever *executed* on the model's behalf when the manifest
allowlists it, and then only through the subcommand gate above.

Secure command execution is fail-closed. It currently requires Linux with
working unprivileged user, mount, PID, and network namespaces plus the standard
`unshare`, `mount`, and `chroot` utilities. A host without those facilities can
still use model, `read`, `write`, mailbox, and dry-run behavior, but an applied
`run` tool call is refused.

## Claims that require qualification

- **“Append-only”** means the runner only appends. Ordinary files remain
  editable by the host operator. Hash chaining makes edits detectable; it does
  not make storage physically immutable.
- **Unsigned audit records** are tamper-evident only when a verifier has retained
  a trusted prior head hash. Someone able to rewrite both trace and result can
  recompute an unsigned chain. Set `SFMA_AUDIT_PRIVATE_KEY` to an Ed25519 PKCS#8
  PEM value when independent authenticity matters, and give verifiers the
  corresponding public key through a separate trusted channel. An embedded
  public key alone proves signature consistency, not operator identity.
- **The command sandbox contains model-directed use of trusted host executables.**
  It is not presented as a hardened container for hostile native binaries or
  kernel exploits.
- **Resource containment is incomplete.** Per-command timeout exists, but CPU,
  memory, file-size, and process-count cgroups/rlimits are not yet implemented.
- **Runner network access remains intentional.** Provider API and OAuth calls
  occur in the runner so the model can be reached. The executed child command is
  the component placed in a network namespace.
- **The host operator is trusted.** The operator chooses the workspace,
  manifest, allowed executable basenames, provider endpoints, and signing key.
- **External observability in SPEC §7 is still external.** The internal trace is
  now verifiable evidence, but it is not a substitute for a host-side observer
  when the stronger “no unobserved path” architecture is required.

## Not claimed

- Protection from a malicious host administrator, compromised kernel, or a
  trusted executable containing an escape vulnerability.
- Confidentiality of model inputs from the configured model provider.
- Exhaustive control of CPU, RAM, disk, or process exhaustion.
- Reproducibility of non-pinned model behavior.
- Cryptographic authenticity when no audit signing key is configured and no
  trusted trace head is retained externally.

## Verify a run

```bash
node scripts/verify_audit.mjs path/to/workspace
```

For signed records, supply an Ed25519 PKCS#8 private key to the runner without
placing it in the manifest or workspace:

```bash
export SFMA_AUDIT_PRIVATE_KEY="$(cat /secure/path/audit-ed25519-private.pem)"
node agent.mjs manifest.json --apply
SFMA_AUDIT_PUBLIC_KEY="$(cat /trusted/path/audit-ed25519-public.pem)" \
  node scripts/verify_audit.mjs path/to/workspace
```

The child-command environment is scrubbed, so this key and provider credentials
are not inherited by allowlisted commands.
