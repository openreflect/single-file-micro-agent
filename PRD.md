# Single File Micro Agent PRD

## Summary

Single File Micro Agent is a small public framework for bounded, authorized agent runs on systems the operator owns. It starts with task manifests and deterministic validation before adding model adapters and execution loops. See [SPEC.md](SPEC.md) for the full architecture.

## Problem

Full agent systems are useful, but they can be too heavy for small repeatable tasks. A public pattern is needed for tiny autonomous agents that operate in a constrained workspace on an authorized host, with explicit permissions and durable, auditable outputs.

## Goals

- Define a task manifest format.
- Validate workspace, command policy, and output declarations.
- Keep the model/API layer swappable.
- Make every run produce a result record.
- Support public synthetic fixtures without private credentials.

## Non-goals

- Providing unrestricted shell access.
- Running on, or reaching, systems the operator does not own or is not authorized to use.
- Any operation the observable boundary cannot see, or any action outside the declared workspace and command allowlist.
- Encoding private deployment paths.
- Replacing larger agent runtimes.
- Hiding model/provider behavior behind vague abstractions.

## First release scope

- Task manifest schema.
- Manifest validator.
- Synthetic task fixture.
- Public/private repository guidance.

## Future scope

- Single-file runner.
- Asynchronous multi-loop flywheel core, governed by a two-tier epsilon judge (SPEC §5).
- Configuration lifecycle: probation, statistical certification from traces, pinning (SPEC §5.6).
- Endpoint weight grid: self-tuned weighted access across a minimum of 3 LLM API endpoints (SPEC §5.7).
- Dual-clock record: monotonic ordering plus scheduled NTP re-anchor (SPEC §4).
- Tiered, type-agnostic, self-profiling memory (SPEC §6).
- Provider adapter interface.
- Dry-run and apply modes.
- Result log format, capturing emergent configuration and event ordering.
- Minimal test harness for command policy enforcement.
