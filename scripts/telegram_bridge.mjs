#!/usr/bin/env node
// Telegram bridge — deliberately OUTSIDE the single file (SPEC §3). One of
// many possible chat surfaces over the operator mailbox (DEFINITIONS §8):
// relays your Telegram messages into .sfma/inbox/ and posts .sfma/outbox/
// messages (notify/ask) to your chat. The engine never learns what Telegram
// is — it only ever reads and writes the two folders.
//
// Setup:
//   1. Message @BotFather -> /newbot -> export TELEGRAM_BOT_TOKEN=...
//   2. Run once WITHOUT TELEGRAM_CHAT_ID, send your bot any message, and the
//      bridge prints your chat id (discovery mode, no inbox writes).
//   3. export TELEGRAM_CHAT_ID=<that id> and run again.
//
// Security: only messages from TELEGRAM_CHAT_ID are relayed to the inbox —
// anyone else who finds the bot is ignored and logged. Inbox files carry the
// sender in their filename, so the trace attributes who said what. And the
// restriction-only rule (SPEC §5.5) still bounds every message underneath.
//
// Usage: node scripts/telegram_bridge.mjs <workspace>
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ws = process.argv[2];
if (!ws) { console.error("usage: telegram_bridge.mjs <workspace>"); process.exit(2); }
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("TELEGRAM_BOT_TOKEN is not set — create a bot via @BotFather first"); process.exit(2); }
const allowed = process.env.TELEGRAM_CHAT_ID;
const api = `${process.env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${token}`;
const pollTimeout = Number(process.env.TELEGRAM_POLL_TIMEOUT ?? 25);

const inbox = path.join(ws, ".sfma", "inbox");
const outbox = path.join(ws, ".sfma", "outbox");
fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(outbox, { recursive: true });
const statePath = path.join(ws, ".sfma", "telegram_state.json");
let state = { offset: 0, sent: [] };
try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
const save = () => fs.writeFileSync(statePath, JSON.stringify({ ...state, sent: state.sent.slice(-500) }));

const call = async (method, params) => {
  const res = await fetch(`${api}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout((pollTimeout + 10) * 1000) });
  const j = await res.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || res.status}`);
  return j.result;
};

let stop = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stop = true));

async function outboxLoop() {
  if (!allowed) return;
  while (!stop) {
    for (const f of fs.readdirSync(outbox).sort()) {
      if (state.sent.includes(f)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(outbox, f), "utf8"));
        await call("sendMessage", { chat_id: Number(allowed), text: `[${m.kind}] ${m.text}` });
        state.sent.push(f);
        save();
        console.log(`outbox -> telegram: ${f}`);
      } catch (err) {
        console.error(`outbox relay failed for ${f}: ${err.message}`);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function inboxLoop() {
  if (!allowed) console.log("TELEGRAM_CHAT_ID not set — discovery mode: message your bot and I will print your chat id (no inbox writes)");
  while (!stop) {
    let updates = [];
    try { updates = await call("getUpdates", { offset: state.offset, timeout: pollTimeout }); }
    catch (err) {
      console.error(`getUpdates failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      state.offset = Math.max(state.offset, u.update_id + 1);
      save();
      const msg = u.message;
      if (!msg?.text) continue;
      if (!allowed) { console.log(`chat id ${msg.chat.id} (@${msg.chat.username || "?"}) — set TELEGRAM_CHAT_ID=${msg.chat.id}`); continue; }
      if (String(msg.chat.id) !== String(allowed)) { console.error(`ignored message from unauthorized chat ${msg.chat.id}`); continue; }
      const file = `${Date.now()}-telegram-${msg.chat.username || msg.chat.id}.txt`;
      fs.writeFileSync(path.join(inbox, file), msg.text.trim() + "\n");
      console.log(`telegram -> inbox: ${file}`);
    }
  }
}

console.log(`telegram bridge on ${ws} (${allowed ? `chat ${allowed}` : "discovery mode"})`);
await Promise.all([outboxLoop(), inboxLoop()]);
