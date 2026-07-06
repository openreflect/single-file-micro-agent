#!/usr/bin/env node
// Operator chat surface — deliberately OUTSIDE the single file (SPEC §3).
// The engine only ever reads .sfma/inbox/ and writes .sfma/outbox/; this
// script is one possible surface over those folders. Any platform (OpenClaw,
// Hermes, a Slack bot, cron mail) can be the chat UI by speaking the same
// two-folder protocol.
//
// Usage: node scripts/chat.mjs <workspace>
// Lines you type land in the inbox and reach the agent at its next run.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const ws = process.argv[2];
if (!ws) { console.error("usage: chat.mjs <workspace>"); process.exit(2); }
const outbox = path.join(ws, ".sfma", "outbox");
const inbox = path.join(ws, ".sfma", "inbox");
fs.mkdirSync(outbox, { recursive: true });
fs.mkdirSync(inbox, { recursive: true });

const seen = new Set();
const poll = () => {
  for (const f of fs.readdirSync(outbox).sort()) {
    if (seen.has(f)) continue;
    seen.add(f);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(outbox, f), "utf8"));
      process.stdout.write(`\r[agent ${m.kind} @ ${m.at}] ${m.text}\nyou> `);
    } catch {}
  }
};
poll();
setInterval(poll, 1000);

console.log("sfma chat — your messages land in the inbox for the agent's next run; Ctrl-C to leave");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.prompt();
rl.on("line", (line) => {
  if (line.trim()) fs.writeFileSync(path.join(inbox, `${Date.now()}-operator.txt`), line.trim() + "\n");
  rl.prompt();
});
rl.on("close", () => process.exit(0));
