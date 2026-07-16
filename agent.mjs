#!/usr/bin/env node
// Single File Micro Agent — M0 containment-floor runner.
// Runs under Node >= 18 and Deno (node: compat). SPEC.md is normative;
// field definitions in docs/DEFINITIONS.md. M0 scope: one loop, manifest
// enforcement (epsilon hard tier), dry-run, trace, result record.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";

const GENESIS_VERSION = "genesis-v1";
const genesis = (i, n, manifest, task, dry) => `You are loop ${i} of ${n} in a Single File Micro Agent run.
You are one asynchronous worker among peers. There is no central coordinator.

THE CONTRACT (immutable — you cannot change these, only work within them):
1. This run is governed by the task manifest below. The workspace is the only
   filesystem region this run may touch. Commands not in allowedCommands cannot
   be run. Files not in outputs cannot be declared as results. The run ends at
   maxTurns. Dry-run mode for this run: ${dry}.
2. You communicate with other loops ONLY by reading and writing traces in the
   shared memory medium. You never assume another loop's state; you observe it.
3. Every task you create, result you produce, and judgment you make is judged
   by epsilon. Work persists only while it passes. A hard-tier failure
   (workspace, command, output, or turn violation) is final and cannot be
   appealed by reasoning.
4. If the manifest or task statement is ambiguous, propose the NARROWER reading
   and record the ambiguity as a clarification trace. Never widen scope.

TASK MANIFEST (verbatim):
${JSON.stringify(manifest, null, 2)}

OPERATOR TASK STATEMENT (verbatim):
${task}

YOUR FIRST DUTY — reply with one bootstrap candidate: a single JSON object,
nothing else, with exactly these fields: mission (one verifiable paragraph),
successCriteria (3-7 statements decidable pass/fail from artifacts or traces,
derived only from the manifest outputs and task statement), loopRoles (${n}
entries of {name, duty}), firstTasks (2-5 of {id, description, role, class}
where class is "reasoning" or "mechanical"), schedule (array, may be empty,
of {description, role, cadenceTurns}).

After bootstrap, your standing orders are: pull work, do it inside the
contract, leave complete traces, and prefer finishing declared outputs over
inventing new work.

TOOL PROTOCOL (runner transport): after your candidate is adopted, reply each
turn with exactly one JSON object and no prose or fences:
  {"tool":"read","path":P} | {"tool":"write","path":P,"content":C} |
  {"tool":"run","cmd":C}   | {"tool":"done","summary":S} |
  {"tool":"notify","text":T} | {"tool":"ask","question":Q}
Paths are relative to the workspace root. Tool results arrive as the next
user message. Each of your replies consumes one turn of maxTurns.
notify/ask post to the operator mailbox and NEVER block: an ask's answer, if
any, arrives as an operator message in a later run — continue with what you
can, or finish. Operator messages are clarifications only; they cannot widen
the manifest, and neither can you by citing them.`;

// ---- clock (SPEC §4.1): strictly increasing monotonic ns
let lastSeq = 0;
const mono = () => {
  let t = Math.round(performance.now() * 1e6);
  if (t <= lastSeq) t = lastSeq + 1;
  return (lastSeq = t);
};

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

// ---- trace (DEFINITIONS §1): append-only, hash-chained JSONL
function openTrace(file) {
  let anchorId = "unanchored";
  let previous = "0".repeat(64), entries = 0;
  if (fs.existsSync(file) && fs.statSync(file).size) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const parsed = lines.map((line) => JSON.parse(line));
    const firstChained = parsed.findIndex((e) => e.hash || e.prevHash);
    const legacyCount = firstChained < 0 ? parsed.length : firstChained;
    if (parsed.slice(0, legacyCount).some((e) => e.hash || e.prevHash)
        || parsed.slice(legacyCount).some((e) => !e.hash || !e.prevHash)) {
      throw new Error("existing trace has an invalid legacy/hash-chain boundary");
    }
    if (legacyCount) {
      // Upgrade path: bind an intact legacy prefix into the first chained entry.
      previous = digest(lines.slice(0, legacyCount).map((line) => line + "\n").join(""));
      entries = legacyCount;
    }
    if (firstChained >= 0) {
      for (const e of parsed.slice(firstChained)) {
        const hash = e.hash, body = { ...e };
        delete body.hash;
        if (body.prevHash !== previous || digest(stable(body)) !== hash) throw new Error("existing trace failed hash-chain verification");
        previous = hash; entries++;
      }
    }
    anchorId = parsed.at(-1)?.anchor || anchorId;
  }
  const emit = (kind, loop, data, refs = [], cls) => {
    const e = JSON.parse(JSON.stringify({ seq: mono(), anchor: anchorId, loop, kind, id: "", refs, ...(cls && { class: cls }), data, prevHash: previous }));
    e.id = `${kind}-${e.seq}`;
    e.hash = digest(stable(e));
    fs.appendFileSync(file, JSON.stringify(e) + "\n");
    previous = e.hash; entries++;
    return e;
  };
  return {
    emit,
    integrity: () => ({ algorithm: "sha256-chain-v1", headHash: previous, entries }),
    anchor(source) {
      const e = emit("clock-anchor", 0, { wallMs: Date.now(), source });
      anchorId = e.id;
      return e;
    },
  };
}

// ---- manifest validation (schema v2 subset; scripts/validate_task.py is canonical)
function validate(m) {
  const errs = [];
  const req = { name: "string", workspace: "string", allowedCommands: "object", inputs: "object", outputs: "object", maxTurns: "number", dryRunDefault: "boolean" };
  for (const [k, t] of Object.entries(req)) if (typeof m[k] !== t) errs.push(`missing or invalid: ${k}`);
  if ("modelAdapter" in m) errs.push("modelAdapter was replaced by modelEndpoints in schema v2");
  if (!Array.isArray(m.modelEndpoints) || m.modelEndpoints.length < 1) errs.push("modelEndpoints must declare at least 1 endpoint");
  else for (const ep of m.modelEndpoints) if (!ep.name || !ep.provider || !ep.model) errs.push("endpoint needs name, provider, model");
  if (!Number.isInteger(m.maxTurns) || m.maxTurns < 1) errs.push("maxTurns must be an integer of at least 1");
  for (const field of ["inputs", "outputs"]) {
    if (!Array.isArray(m[field])) { errs.push(`${field} must be an array`); continue; }
    for (const value of m[field]) {
      if (typeof value !== "string" || !value || path.isAbsolute(value) || path.normalize(value).startsWith("..")) errs.push(`${field} entries must be non-empty relative paths: ${value}`);
      if (field === "outputs" && (path.normalize(value) === ".sfma" || path.normalize(value).startsWith(`.sfma${path.sep}`))) errs.push("outputs cannot target reserved .sfma audit state");
    }
  }
  if (!Array.isArray(m.allowedCommands)) errs.push("allowedCommands must be an array");
  else for (const command of m.allowedCommands) if (typeof command !== "string" || !command || command !== path.basename(command) || /\s/.test(command)) errs.push(`allowedCommands entries must be executable basenames: ${command}`);
  const ranges = { maxModelCalls: [1, 100000], maxSeconds: [1, 86400], maxLoops: [1, 16], maxPendingTasks: [1, 4096] };
  for (const [field, [low, high]] of Object.entries(ranges)) if (field in m && (!Number.isInteger(m[field]) || m[field] < low || m[field] > high)) errs.push(`${field} must be an integer in [${low}, ${high}]`);
  return errs;
}

// ---- containment floor (SPEC §5.3 hard tier): pure code, no model calls
function resolveIn(ws, p) {
  const abs = path.resolve(ws, String(p));
  const rel = path.relative(ws, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`outside workspace: ${p}`);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  if (path.relative(fs.realpathSync(ws), fs.realpathSync(probe)).startsWith("..")) throw new Error(`escapes workspace via link: ${p}`);
  return abs;
}
function checkCmd(cmd, allowed) {
  if (/[;&|<>`$(){}\n\\]/.test(cmd)) throw new Error("shell metacharacters are not allowed");
  const argv = String(cmd).trim().split(/\s+/);
  if (!argv[0]) throw new Error("empty command");
  const executable = path.basename(argv[0]);
  if (!allowed.includes(executable)) throw new Error(`command not in allowedCommands: ${argv[0]}`);
  argv[0] = executable; // never honor a model-supplied executable path
  return argv;
}

function outputPath(ws, p, outputs) {
  const abs = resolveIn(ws, p);
  const rel = path.relative(ws, abs);
  const declared = outputs.map((o) => path.normalize(String(o)));
  if (!declared.includes(rel)) throw new Error(`write is not a declared output: ${p}`);
  if (rel === ".sfma" || rel.startsWith(`.sfma${path.sep}`)) throw new Error(".sfma audit state is reserved to the runner");
  return abs;
}

const SANDBOX_SCRIPT = String.raw`set -eu
root=$1; stage=$2; shift 2
mount --make-rprivate /
mount -t tmpfs -o mode=0755 tmpfs "$root"
mkdir -p "$root/usr" "$root/workspace" "$root/tmp" "$root/dev"
mount --rbind /usr "$root/usr"
mount -o remount,ro,bind "$root/usr"
ln -s usr/bin "$root/bin"
ln -s usr/lib "$root/lib"
[ ! -e /lib64 ] || ln -s usr/lib64 "$root/lib64"
mount --bind "$stage" "$root/workspace"
touch "$root/dev/null"
mount --bind /dev/null "$root/dev/null"
/usr/sbin/chroot "$root" /bin/sh -ceu 'cd /workspace; exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/workspace TMPDIR=/tmp "$@"' sh "$@"`;

function assertNoSymlinks(src) {
  const info = fs.lstatSync(src);
  if (info.isSymbolicLink()) throw new Error(`symbolic links are not accepted at the containment boundary: ${src}`);
  if (info.isDirectory()) for (const name of fs.readdirSync(src)) assertNoSymlinks(path.join(src, name));
  return info;
}

function copyTreeSafe(src, dst) {
  const info = assertNoSymlinks(src);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: info.isDirectory(), dereference: false });
}

function runSandboxed(state, argv) {
  if (process.platform !== "linux") throw new Error("secure command sandbox unavailable: Linux user/mount/network namespaces are required");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sfma-sandbox-"));
  const stage = path.join(base, "stage"), root = path.join(base, "root");
  fs.mkdirSync(stage); fs.mkdirSync(root);
  try {
    for (const input of state.manifest.inputs) {
      const src = resolveIn(state.ws, input);
      if (!fs.existsSync(src)) throw new Error(`declared input does not exist: ${input}`);
      copyTreeSafe(src, path.join(stage, path.normalize(String(input))));
    }
    const r = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "/bin/sh", "-ceu", SANDBOX_SCRIPT, "sh", root, stage, ...argv], {
      timeout: 60000, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
    });
    if (r.error) throw new Error(`secure command sandbox unavailable: ${r.error.message}`);
    if (r.status === 125 || /unshare failed|Operation not permitted/.test(r.stderr || "")) throw new Error(`secure command sandbox unavailable: ${(r.stderr || "namespace setup failed").trim()}`);
    for (const output of state.manifest.outputs) {
      const staged = path.join(stage, path.normalize(String(output)));
      if (!fs.existsSync(staged)) continue;
      const dst = outputPath(state.ws, output, state.manifest.outputs);
      copyTreeSafe(staged, dst);
      state.writes.set(path.relative(state.ws, dst), true);
    }
    return r;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ---- providers (SPEC §5.7; M0: prior-ranked failover, EWMA measurement)
// Auth per endpoint: default is a provider API key from env; an optional
// manifest `auth` block ({type:"oauth2-client-credentials", tokenUrl,
// clientIdEnv, clientSecretEnv, scope?}) switches the endpoint to OAuth2 —
// tokens are fetched, cached, and refreshed 60s before expiry. Secrets stay
// in env (SPEC §10); the manifest names variables, never values.
const KEYS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", codex: "OPENAI_CODEX_TOKEN" };
const tokenCache = {};
async function authHeaders(ep) {
  const a = ep.auth;
  if (!a) {
    const key = process.env[KEYS[ep.provider]];
    return ep.provider === "anthropic" ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
  }
  if (a.type !== "oauth2-client-credentials") throw new Error(`unsupported auth type: ${a.type}`);
  const cached = tokenCache[ep.name];
  if (cached && cached.exp > Date.now() + 60000) return { authorization: `Bearer ${cached.token}` };
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: process.env[a.clientIdEnv] ?? "", client_secret: process.env[a.clientSecretEnv] ?? "", ...(a.scope && { scope: a.scope }) });
  const res = await fetch(a.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`oauth token endpoint HTTP ${res.status}`);
  const tok = await res.json();
  tokenCache[ep.name] = { token: tok.access_token, exp: Date.now() + (tok.expires_in ?? 300) * 1000 };
  return { authorization: `Bearer ${tok.access_token}` };
}
const providers = {
  anthropic: async (ep, auth, sys, msgs) => {
    const r = await post(`${ep.baseUrl || "https://api.anthropic.com"}/v1/messages`, { ...auth, "anthropic-version": "2023-06-01" }, { model: ep.model, max_tokens: 4096, system: sys, messages: msgs });
    return r.content[0].text;
  },
  openai: async (ep, auth, sys, msgs) => {
    const r = await post(`${ep.baseUrl || "https://api.openai.com"}/v1/chat/completions`, auth, { model: ep.model, messages: [{ role: "system", content: sys }, ...msgs] });
    return r.choices[0].message.content;
  },
  gemini: async (ep, auth, sys, msgs) => {
    const keyParam = ep.auth ? "" : `?key=${process.env[KEYS.gemini]}`;
    const r = await post(`${ep.baseUrl || "https://generativelanguage.googleapis.com"}/v1beta/models/${ep.model}:generateContent${keyParam}`, ep.auth ? auth : {}, { system_instruction: { parts: [{ text: sys }] }, contents: msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })) });
    return r.candidates[0].content.parts[0].text;
  },
  // ChatGPT-plan OAuth via the Codex backend (Responses API over SSE). Tokens
  // are provisioned OUTSIDE the file by scripts/codex_env.mjs (or OpenClaw /
  // `codex login`); the agent only consumes env. Unofficial surface — expect
  // drift; failures fail over like any endpoint.
  codex: async (ep, auth, sys, msgs) => {
    const res = await fetch(`${ep.baseUrl || "https://chatgpt.com/backend-api/codex"}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...auth, "chatgpt-account-id": process.env.OPENAI_CODEX_ACCOUNT ?? "", "OpenAI-Beta": "responses=experimental", originator: "codex_cli_rs", session_id: crypto.randomUUID() },
      body: JSON.stringify({ model: ep.model, instructions: sys, input: msgs.map((m) => ({ type: "message", role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] })), store: false, stream: true }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`codex HTTP ${res.status}: ${clip(await res.text(), 300)}`);
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).flatMap((l) => { try { return [JSON.parse(l.slice(6))]; } catch { return []; } });
    const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    if (deltas) return deltas;
    const texts = (events.find((e) => e.type === "response.completed")?.response?.output || []).flatMap((o) => (o.content || []).filter((c) => c.type === "output_text").map((c) => c.text));
    if (!texts.length) throw new Error("codex: no output_text in stream");
    return texts.join("");
  },
  mock: async (ep, auth, sys, msgs, state) => {
    if (!state.mockQ) state.mockQ = process.env.SFMA_MOCK ? JSON.parse(process.env.SFMA_MOCK) : defaultMock(state.manifest);
    const next = state.mockQ.shift() ?? { tool: "done", summary: "mock queue exhausted" };
    return typeof next === "string" ? next : JSON.stringify(next);
  },
};
async function post(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url.split("/")[2]} HTTP ${res.status}`);
  return res.json();
}
const defaultMock = (m) => [
  { mission: `Produce the declared outputs for task "${m.name}" inside the workspace.`, successCriteria: m.outputs.map((o) => `${o} exists in the workspace`), loopRoles: [{ name: "solo", duty: "do the work and check it" }], firstTasks: m.outputs.map((o, i) => ({ id: `t${i}`, description: `write ${o}`, role: "solo", class: "mechanical" })), schedule: [] },
  ...m.outputs.map((o) => ({ tool: "write", path: o, content: `MOCK ${o}\n` })),
  { tool: "done", summary: "mock complete" },
];

// exclude: judge independence (SPEC §5.3) — a soft-tier judgment call passes
// the name of the endpoint that produced the judged work; it is skipped when
// any other endpoint is usable.
function grid(endpoints, cls, exclude) {
  const usable = endpoints.filter((ep) => ep.provider === "mock" || (ep.auth ? process.env[ep.auth.clientIdEnv] && process.env[ep.auth.clientSecretEnv] : process.env[KEYS[ep.provider]]));
  const independent = exclude ? usable.filter((ep) => ep.name !== exclude) : usable;
  return (independent.length ? independent : usable).sort((a, b) => ((b.priors || {})[cls] ?? 0.5) - ((a.priors || {})[cls] ?? 0.5));
}
async function callModel(state, sys, msgs, cls, exclude) {
  const ranked = grid(state.manifest.modelEndpoints, cls, exclude);
  if (!ranked.length) throw new Error("no usable endpoint: no API key found and no mock configured");
  for (const ep of ranked) {
    if (state.calls >= state.budget.maxModelCalls) { state.halted = "budget"; throw new Error(`budget: maxModelCalls (${state.budget.maxModelCalls}) reached`); }
    state.calls++;
    const t0 = performance.now(), s = (state.stats[ep.name] ??= { calls: 0, failures: 0, latencyMsEwma: null });
    try {
      const text = await providers[ep.provider](ep, await authHeaders(ep), sys, msgs, state);
      const ms = performance.now() - t0;
      s.calls++; s.latencyMsEwma = s.latencyMsEwma === null ? ms : 0.3 * ms + 0.7 * s.latencyMsEwma;
      state.trace.emit("call", 1, { endpoint: ep.name, latencyMs: Math.round(ms), ok: true }, [], cls);
      return text;
    } catch (err) {
      s.calls++; s.failures++;
      state.trace.emit("call", 1, { endpoint: ep.name, ok: false, error: String(err.message) }, [], cls);
    }
  }
  throw new Error("all endpoints failed");
}

const parseReply = (text) => {
  const t = String(text).replace(/```(json)?/g, "").trim();
  try { return JSON.parse(t); } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch {}
    return null;
  }
};
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const clip = (s, n = 8192) => (String(s).length > n ? String(s).slice(0, n) + "…[clipped]" : String(s));

// ---- tool dispatch: every call passes the hard tier or is refused
function dispatch(state, call) {
  const { manifest: m, ws, dry } = state;
  const guard = (fn) => {
    try {
      const out = fn();
      state.trace.emit("verdict", 1, { tier: "hard", pass: true, reason: call.tool }, [call.ref]);
      return out;
    } catch (err) {
      state.hardFails++;
      state.trace.emit("verdict", 1, { tier: "hard", pass: false, reason: String(err.message) }, [call.ref]);
      return `EPSILON_HARD_FAIL: ${err.message}`;
    }
  };
  if (call.tool === "read") return guard(() => clip(fs.readFileSync(resolveIn(ws, call.path), "utf8")));
  if (call.tool === "write") return guard(() => {
    const abs = outputPath(ws, call.path, m.outputs);
    state.writes.set(path.relative(ws, abs), true);
    if (dry) return `[dry-run] write of ${call.path} recorded, not applied`;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(call.content ?? ""));
    return `wrote ${call.path}`;
  });
  if (call.tool === "notify" || call.tool === "ask") return guard(() => {
    const text = String(call.text ?? call.question ?? "");
    const e = state.trace.emit("message", 1, { dir: "out", kind: call.tool, text: clip(text, 4096) });
    fs.writeFileSync(path.join(ws, ".sfma", "outbox", `${e.seq}-${call.tool}.json`), JSON.stringify({ kind: call.tool, text, at: new Date().toISOString() }, null, 2));
    return call.tool === "ask"
      ? "question posted to the operator mailbox; the answer, if any, arrives as an operator message in a later run — continue with what you can"
      : "operator notified";
  });
  if (call.tool === "run") return guard(() => {
    const argv = checkCmd(call.cmd, m.allowedCommands);
    if (dry) return `[dry-run] command allowed, not executed: ${call.cmd}`;
    const r = runSandboxed(state, argv);
    return clip(`exit=${r.status}\nstdout:${r.stdout || ""}\nstderr:${r.stderr || ""}`);
  });
  state.hardFails++;
  state.trace.emit("verdict", 1, { tier: "hard", pass: false, reason: `unknown tool: ${call.tool}` }, [call.ref]);
  return `EPSILON_HARD_FAIL: unknown tool: ${call.tool}`;
}

// ---- main
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const taskFlag = (args.find((a) => a.startsWith("--task=")) || "").slice(7);
  const manifestPath = args.find((a) => !a.startsWith("--"));
  if (!manifestPath) { console.error("usage: agent.mjs path/to/manifest.json [--apply] [--task=...]"); return 2; }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const errs = validate(manifest);
  if (errs.length) { console.error("TASK_INVALID\n" + errs.map((e) => `- ${e}`).join("\n")); return 2; }

  const ws = path.resolve(manifest.workspace);
  fs.mkdirSync(path.join(ws, ".sfma"), { recursive: true });
  const trace = openTrace(path.join(ws, ".sfma", "trace.jsonl"));
  const firstSeq = trace.anchor("system-wall").seq;
  const dry = manifest.dryRunDefault && !apply;
  const task = taskFlag || manifest.taskStatement || `Produce the declared outputs (${manifest.outputs.join(", ")}) for task "${manifest.name}".`;
  // arithmetic backstop (SPEC §5.3/§8, DEFINITIONS §6): enforced here in code,
  // regardless of anything a loop or judgment concludes
  const budget = { maxModelCalls: manifest.maxModelCalls ?? manifest.maxTurns * 8, maxSeconds: manifest.maxSeconds ?? 900, maxLoops: manifest.maxLoops ?? 3, maxPendingTasks: manifest.maxPendingTasks ?? 32 };
  const deadline = Date.now() + budget.maxSeconds * 1000;
  const state = { manifest, ws, dry, trace, stats: {}, writes: new Map(), hardFails: 0, calls: 0, budget, halted: null };
  let signal = null;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (signal = sig));
  const haltFile = path.join(ws, ".sfma", "HALT");

  // cross-run memory — the long-term tier at M0.5 (DEFINITIONS §7): recall
  // before work. Endpoint profiles seed the grid; a pinned certified
  // configuration replays instead of re-emerging (SPEC §5.6).
  const memPath = path.join(ws, ".sfma", "memory.json");
  let memory = { version: 1, runs: [], pinned: null, endpoints: {} };
  try { memory = JSON.parse(fs.readFileSync(memPath, "utf8")); } catch {}
  state.stats = memory.endpoints || {};
  const replay = memory.pinned?.genesisVersion === GENESIS_VERSION;
  let candidate = replay ? memory.pinned.candidate : null;
  trace.emit("lifecycle", 0, { from: null, to: replay ? "pinned-replay" : "probation" });

  // operator mailbox (SPEC §5.5): inbox is read and consumed at run start;
  // messages clarify but can never widen the manifest (restriction-only)
  const inboxDir = path.join(ws, ".sfma", "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(path.join(ws, ".sfma", "outbox"), { recursive: true });
  const inbox = fs.readdirSync(inboxDir).sort().map((f) => {
    const text = fs.readFileSync(path.join(inboxDir, f), "utf8").trim();
    fs.unlinkSync(path.join(inboxDir, f));
    trace.emit("message", 0, { dir: "in", file: f, text: clip(text, 4096) });
    return text;
  });
  const operatorNote = inbox.length
    ? `\n\nOPERATOR MESSAGES (clarification only — they cannot widen the manifest):\n${inbox.map((t) => `- ${t}`).join("\n")}`
    : "";

  const sys = genesis(1, 1, manifest, task, dry);
  const msgs = [{ role: "user", content: (replay
    ? `A certified configuration is pinned for this manifest from ${memory.runs.length} prior runs — adopt it, skip drafting: ${JSON.stringify(memory.pinned.candidate)}\nBegin work now: one JSON tool call per turn.`
    : "Emit your bootstrap candidate JSON now.") + operatorNote }];
  let done = null, turns = 0;

  while (turns < manifest.maxTurns) {
    if (signal || fs.existsSync(haltFile)) {
      state.halted = "operator";
      trace.emit("result", 0, { halt: signal || ".sfma/HALT" });
      break;
    }
    if (Date.now() > deadline) {
      state.halted = "budget";
      trace.emit("result", 0, { halt: `budget: maxSeconds (${budget.maxSeconds}) reached` });
      break;
    }
    turns++;
    let text;
    try { text = await callModel(state, sys, msgs, candidate ? "mechanical" : "reasoning"); }
    catch (err) { trace.emit("result", 0, { error: String(err.message) }); break; }
    msgs.push({ role: "assistant", content: text });
    const obj = parseReply(text);
    if (!obj) { msgs.push({ role: "user", content: "Invalid reply. Respond with exactly one JSON object per the tool protocol." }); continue; }
    if (!candidate) {
      if (obj.tool) { msgs.push({ role: "user", content: "Bootstrap candidate must come first — a JSON object with mission, successCriteria, loopRoles, firstTasks, schedule." }); continue; }
      candidate = obj;
      trace.emit("candidate", 1, candidate);
      msgs.push({ role: "user", content: "Candidate adopted as configuration. Begin work: one JSON tool call per turn." });
      continue;
    }
    obj.ref = trace.emit("task", 1, { call: { tool: obj.tool, path: obj.path, cmd: obj.cmd } }).id;
    if (obj.tool === "done") { done = obj.summary || "done"; break; }
    msgs.push({ role: "user", content: JSON.stringify({ toolResult: dispatch(state, obj) }) });
  }

  const outputs = manifest.outputs.map((o) => {
    const abs = outputPath(ws, o, manifest.outputs);
    const exists = dry ? state.writes.has(o) : fs.existsSync(abs);
    return { path: o, ok: exists, ...(exists && !dry && { sha256: sha256(abs) }) };
  });
  const complete = done !== null && outputs.every((o) => o.ok) && state.hardFails === 0;
  const verdict = state.halted ? `halted-${state.halted}` : done === null ? (turns >= manifest.maxTurns ? "halted-maxTurns" : "failed") : complete ? "completed" : "failed";
  trace.emit("weight", 0, state.stats);

  // certification statistics over the run chain (DEFINITIONS §7): pure code
  // over recorded history — no model call, no operator judgment (SPEC §5.6)
  const tun = manifest.tuning || {};
  memory.runs = [...memory.runs, { at: new Date().toISOString(), verdict, turns, modelCalls: state.calls, hardTierFailures: state.hardFails, dryRun: dry }].slice(-100);
  memory.endpoints = state.stats;
  const win = memory.runs.filter((r) => !r.dryRun).slice(-(tun.certWindow ?? 20));
  const passRate = win.length ? win.filter((r) => r.verdict === "completed").length / win.length : 0;
  let transition = null;
  if (memory.pinned && (state.hardFails > 0 || passRate < (tun.demotePass ?? 0.6))) {
    memory.pinned = null;
    transition = "demoted";
  } else if (!memory.pinned && candidate && win.length >= (tun.certWindow ?? 20) && passRate >= (tun.certCompletion ?? 0.9) && win.every((r) => r.hardTierFailures === 0)) {
    memory.pinned = { candidate, genesisVersion: GENESIS_VERSION, certifiedAt: new Date().toISOString() };
    transition = "certified";
  }
  if (transition) trace.emit("lifecycle", 0, { from: replay ? "pinned-replay" : "probation", to: transition });
  fs.writeFileSync(memPath, JSON.stringify(memory, null, 2));

  trace.emit("lifecycle", 0, { from: replay ? "pinned-replay" : "probation", to: verdict });
  const lastAnchor = trace.anchor("system-wall");

  const record = {
    manifest, genesisVersion: GENESIS_VERSION,
    bootstrap: candidate, lifecycle: [replay ? "pinned-replay" : "probation", ...(transition ? [transition] : []), verdict],
    memory: { runs: memory.runs.length, pinned: !!memory.pinned },
    outputs, criteria: (candidate?.successCriteria || []).map((c) => ({ criterion: c, pass: null, evidence: [] })),
    weights: state.stats, mutations: { count: 0, refs: [] },
    clock: { firstSeq, lastSeq: lastAnchor.seq, anchorSource: "system-wall (NTP re-anchor is post-M0)" },
    trace: ".sfma/trace.jsonl", dryRun: dry, turns, modelCalls: state.calls, budget, hardTierFailures: state.hardFails, verdict,
  };
  const integrity = { ...trace.integrity(), manifestSha256: digest(stable(manifest)), resultSha256: digest(stable(record)) };
  if (process.env.SFMA_AUDIT_PRIVATE_KEY) {
    const key = crypto.createPrivateKey(process.env.SFMA_AUDIT_PRIVATE_KEY);
    integrity.signature = {
      algorithm: "ed25519",
      publicKey: crypto.createPublicKey(key).export({ type: "spki", format: "pem" }),
      value: crypto.sign(null, Buffer.from(stable(integrity)), key).toString("base64"),
    };
  }
  record.integrity = integrity;
  fs.writeFileSync(path.join(ws, ".sfma", "result.json"), JSON.stringify(record, null, 2));
  console.log(`${verdict.toUpperCase()} turns=${turns} dryRun=${dry} record=${path.join(manifest.workspace, ".sfma", "result.json")}`);
  return verdict === "completed" ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { console.error(`FATAL: ${err.message}`); process.exit(1); });
