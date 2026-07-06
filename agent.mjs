#!/usr/bin/env node
// Single File Micro Agent — M0 containment-floor runner.
// Runs under Node >= 18 and Deno (node: compat). SPEC.md is normative;
// field definitions in docs/DEFINITIONS.md. M0 scope: one loop, manifest
// enforcement (epsilon hard tier), dry-run, trace, result record.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  {"tool":"run","cmd":C}   | {"tool":"done","summary":S}
Paths are relative to the workspace root. Tool results arrive as the next
user message. Each of your replies consumes one turn of maxTurns.`;

// ---- clock (SPEC §4.1): strictly increasing monotonic ns
let lastSeq = 0;
const mono = () => {
  let t = Math.round(performance.now() * 1e6);
  if (t <= lastSeq) t = lastSeq + 1;
  return (lastSeq = t);
};

// ---- trace (DEFINITIONS §1): append-only JSONL
function openTrace(file) {
  let anchorId = "unanchored";
  const emit = (kind, loop, data, refs = [], cls) => {
    const e = { seq: mono(), anchor: anchorId, loop, kind, id: "", refs, ...(cls && { class: cls }), data };
    e.id = `${kind}-${e.seq}`;
    fs.appendFileSync(file, JSON.stringify(e) + "\n");
    return e;
  };
  return {
    emit,
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
  if (m.maxTurns < 1) errs.push("maxTurns must be at least 1");
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
  if (!allowed.includes(path.basename(argv[0]))) throw new Error(`command not in allowedCommands: ${argv[0]}`);
  return argv;
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

function grid(endpoints, cls) {
  const usable = endpoints.filter((ep) => ep.provider === "mock" || (ep.auth ? process.env[ep.auth.clientIdEnv] && process.env[ep.auth.clientSecretEnv] : process.env[KEYS[ep.provider]]));
  return usable.sort((a, b) => ((b.priors || {})[cls] ?? 0.5) - ((a.priors || {})[cls] ?? 0.5));
}
async function callModel(state, sys, msgs, cls) {
  const ranked = grid(state.manifest.modelEndpoints, cls);
  if (!ranked.length) throw new Error("no usable endpoint: no API key found and no mock configured");
  for (const ep of ranked) {
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
    const abs = resolveIn(ws, call.path);
    state.writes.set(path.relative(ws, abs), true);
    if (dry) return `[dry-run] write of ${call.path} recorded, not applied`;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(call.content ?? ""));
    return `wrote ${call.path}`;
  });
  if (call.tool === "run") return guard(() => {
    const argv = checkCmd(call.cmd, m.allowedCommands);
    if (dry) return `[dry-run] command allowed, not executed: ${call.cmd}`;
    const r = spawnSync(argv[0], argv.slice(1), { cwd: ws, timeout: 60000, encoding: "utf8" });
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
  const state = { manifest, ws, dry, trace, stats: {}, writes: new Map(), hardFails: 0 };
  trace.emit("lifecycle", 0, { from: null, to: "probation" });

  const sys = genesis(1, 1, manifest, task, dry);
  const msgs = [{ role: "user", content: "Emit your bootstrap candidate JSON now." }];
  let candidate = null, done = null, turns = 0;

  while (turns < manifest.maxTurns) {
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
    const abs = path.join(ws, o);
    const exists = dry ? state.writes.has(o) : fs.existsSync(abs);
    return { path: o, ok: exists, ...(exists && !dry && { sha256: sha256(abs) }) };
  });
  const complete = done !== null && outputs.every((o) => o.ok) && state.hardFails === 0;
  const verdict = done === null ? (turns >= manifest.maxTurns ? "halted-maxTurns" : "failed") : complete ? "completed" : "failed";
  trace.emit("weight", 0, state.stats);
  trace.emit("lifecycle", 0, { from: "probation", to: verdict });
  const lastAnchor = trace.anchor("system-wall");

  const record = {
    manifest, genesisVersion: GENESIS_VERSION,
    bootstrap: candidate, lifecycle: ["probation", verdict],
    outputs, criteria: (candidate?.successCriteria || []).map((c) => ({ criterion: c, pass: null, evidence: [] })),
    weights: state.stats, mutations: { count: 0, refs: [] },
    clock: { firstSeq, lastSeq: lastAnchor.seq, anchorSource: "system-wall (NTP re-anchor is post-M0)" },
    trace: ".sfma/trace.jsonl", dryRun: dry, turns, hardTierFailures: state.hardFails, verdict,
  };
  fs.writeFileSync(path.join(ws, ".sfma", "result.json"), JSON.stringify(record, null, 2));
  console.log(`${verdict.toUpperCase()} turns=${turns} dryRun=${dry} record=${path.join(manifest.workspace, ".sfma", "result.json")}`);
  return verdict === "completed" ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { console.error(`FATAL: ${err.message}`); process.exit(1); });
