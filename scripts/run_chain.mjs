#!/usr/bin/env node
// Outer relay — deliberately OUTSIDE the single file (SPEC §3/§8). Extended
// autonomy is a chain of bounded runs: each re-enters the manifest contract
// under its own budget, leaves its own result record, and cross-run memory
// (.sfma/memory.json) carries what was learned between them. Residency is
// the operator's choice, never the agent's.
//
// Usage:
//   node scripts/run_chain.mjs manifest.json [--every=300] [--max-runs=0] [--apply] [--task=...]
//
// Stops on: SIGINT/SIGTERM (after the current run finishes), a .sfma/HALT
// sentinel in the workspace, a rejected manifest (exit 2), or --max-runs.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith("--"));
if (!manifestPath) {
  console.error("usage: run_chain.mjs manifest.json [--every=300] [--max-runs=0] [--apply] [--task=...]");
  process.exit(2);
}
const opt = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : dflt;
};
const every = opt("every", 300);
const maxRuns = opt("max-runs", 0);
const ws = path.resolve(JSON.parse(fs.readFileSync(manifestPath, "utf8")).workspace);
const passthru = args.filter((a) => a === "--apply" || a.startsWith("--task="));
const agent = new URL("../agent.mjs", import.meta.url).pathname;

let stop = null;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stop = sig));

for (let run = 1; !stop && (maxRuns === 0 || run <= maxRuns); run++) {
  if (fs.existsSync(path.join(ws, ".sfma", "HALT"))) {
    console.log("chain: HALT sentinel found — stopping");
    break;
  }
  console.log(`chain: run ${run}${maxRuns ? `/${maxRuns}` : ""}`);
  const r = spawnSync(process.execPath, [agent, manifestPath, ...passthru], { stdio: "inherit" });
  if (r.status === 2) {
    console.error("chain: manifest rejected — stopping");
    process.exit(2);
  }
  if (stop || (maxRuns !== 0 && run >= maxRuns)) break;
  await new Promise((res) => setTimeout(res, every * 1000));
}
console.log(`chain: done${stop ? ` (${stop})` : ""}`);
