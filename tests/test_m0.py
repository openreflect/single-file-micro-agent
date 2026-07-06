#!/usr/bin/env python3
"""M0 floor tests: manifest enforcement, dry-run, trace, result record.

Offline by design — every run uses the deterministic mock provider, scripted
via the SFMA_MOCK environment variable. Requires node (or deno) on PATH.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AGENT = REPO / "agent.mjs"

if shutil.which("node"):
    RUNNER = ["node", str(AGENT)]
elif shutil.which("deno"):
    RUNNER = ["deno", "run", "-A", str(AGENT)]
else:
    raise RuntimeError("neither node nor deno found on PATH")

CANDIDATE = {
    "mission": "Produce result.json in the workspace.",
    "successCriteria": ["result.json exists in the workspace"],
    "loopRoles": [{"name": "solo", "duty": "do the work"}],
    "firstTasks": [{"id": "t0", "description": "write result.json", "role": "solo", "class": "mechanical"}],
    "schedule": [],
}


class M0Test(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="sfma-m0-"))
        self.ws = self.dir / "ws"
        self.ws.mkdir()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def manifest(self, **over):
        m = {
            "name": "m0-test",
            "workspace": str(self.ws),
            "modelEndpoints": [{"name": "mock", "provider": "mock", "model": "m0"}],
            "allowedCommands": ["echo"],
            "inputs": [],
            "outputs": ["result.json"],
            "maxTurns": 6,
            "dryRunDefault": True,
        }
        m.update(over)
        p = self.dir / "manifest.json"
        p.write_text(json.dumps(m))
        return p

    def run_agent(self, manifest, script=None, apply=True):
        env = {**os.environ}
        if script is not None:
            env["SFMA_MOCK"] = json.dumps(script)
        args = RUNNER + [str(manifest)] + (["--apply"] if apply else [])
        return subprocess.run(args, capture_output=True, text=True, env=env, timeout=120)

    def record(self):
        return json.loads((self.ws / ".sfma" / "result.json").read_text())

    def traces(self):
        lines = (self.ws / ".sfma" / "trace.jsonl").read_text().strip().splitlines()
        return [json.loads(line) for line in lines]

    def verdicts(self, tier="hard"):
        return [t for t in self.traces() if t["kind"] == "verdict" and t["data"]["tier"] == tier]

    def test_happy_path_apply(self):
        script = [CANDIDATE, {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((self.ws / "result.json").read_text(), "ok")
        rec = self.record()
        self.assertEqual(rec["verdict"], "completed")
        self.assertEqual(rec["bootstrap"]["mission"], CANDIDATE["mission"])
        self.assertTrue(rec["outputs"][0]["sha256"])
        self.assertEqual(rec["hardTierFailures"], 0)
        kinds = {t["kind"] for t in self.traces()}
        self.assertLessEqual({"clock-anchor", "lifecycle", "candidate", "call", "task", "verdict", "weight"}, kinds)

    def test_dry_run_writes_nothing(self):
        script = [CANDIDATE, {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        r = self.run_agent(self.manifest(), script, apply=False)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse((self.ws / "result.json").exists())
        rec = self.record()
        self.assertTrue(rec["dryRun"])
        self.assertEqual(rec["verdict"], "completed")

    def test_disallowed_command_refused(self):
        script = [CANDIDATE, {"tool": "run", "cmd": "curl http://example.com"},
                  {"tool": "done", "summary": "tried"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.record()["verdict"], "failed")
        fails = [v for v in self.verdicts() if not v["data"]["pass"]]
        self.assertIn("not in allowedCommands", fails[0]["data"]["reason"])

    def test_shell_metacharacters_refused(self):
        script = [CANDIDATE, {"tool": "run", "cmd": "echo hi; curl evil"},
                  {"tool": "done", "summary": "tried"}]
        self.run_agent(self.manifest(), script)
        fails = [v for v in self.verdicts() if not v["data"]["pass"]]
        self.assertIn("metacharacters", fails[0]["data"]["reason"])

    def test_workspace_escape_refused(self):
        script = [CANDIDATE, {"tool": "write", "path": "../evil.txt", "content": "x"},
                  {"tool": "done", "summary": "tried"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 1)
        self.assertFalse((self.dir / "evil.txt").exists())
        fails = [v for v in self.verdicts() if not v["data"]["pass"]]
        self.assertIn("outside workspace", fails[0]["data"]["reason"])

    def test_allowed_command_runs(self):
        script = [CANDIDATE, {"tool": "run", "cmd": "echo floor-ok"},
                  {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.record()["hardTierFailures"], 0)

    def test_max_turns_halts(self):
        script = [CANDIDATE] + [{"tool": "read", "path": "nope.txt"}] * 20
        r = self.run_agent(self.manifest(maxTurns=4), script)
        self.assertEqual(r.returncode, 1)
        rec = self.record()
        self.assertEqual(rec["verdict"], "halted-maxTurns")
        self.assertEqual(rec["turns"], 4)

    def test_invalid_manifest_rejected(self):
        p = self.manifest()
        p.write_text(json.dumps({"name": "bad", "modelAdapter": "v1"}))
        r = self.run_agent(p, [CANDIDATE])
        self.assertEqual(r.returncode, 2)
        self.assertIn("TASK_INVALID", r.stderr)
        self.assertIn("modelAdapter was replaced", r.stderr)

    def test_trace_is_ordered_and_anchored(self):
        script = [CANDIDATE, {"tool": "done", "summary": "minimal"}]
        self.run_agent(self.manifest(outputs=[]), script)
        traces = self.traces()
        seqs = [t["seq"] for t in traces]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))
        self.assertEqual(traces[0]["kind"], "clock-anchor")
        self.assertTrue(all(t["anchor"].startswith("clock-anchor-") for t in traces[1:]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
