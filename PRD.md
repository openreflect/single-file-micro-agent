# Micro Agent Sandbox PRD

## Summary

Micro Agent Sandbox is a small public framework for bounded autonomous worker runs. It starts with task manifests and deterministic validation before adding model adapters and execution loops.

## Problem

Full agent systems are useful, but they can be too heavy for small repeatable tasks. A public pattern is needed for tiny autonomous agents that can operate in a constrained workspace with explicit permissions and durable outputs.

## Goals

- Define a task manifest format.
- Validate workspace, command policy, and output declarations.
- Keep the model/API layer swappable.
- Make every run produce a result record.
- Support public synthetic fixtures without private credentials.

## Non-goals

- Providing unrestricted shell access.
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
- Provider adapter interface.
- Dry-run and apply modes.
- Result log format.
- Minimal test harness for command policy enforcement.
