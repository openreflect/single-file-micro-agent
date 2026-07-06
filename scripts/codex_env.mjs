#!/usr/bin/env node
// Credential helper — deliberately OUTSIDE the single file (SPEC §3/§10).
// Bridges the ChatGPT/Codex OAuth session provisioned by `codex login` (and
// shared by OpenClaw) into env vars for agent.mjs, refreshing the access
// token when it is near expiry.
//
// Usage:
//   node scripts/codex_env.mjs -- node agent.mjs manifest.json --apply
//   eval "$(node scripts/codex_env.mjs)"     # export into current shell
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const AUTH = path.join(os.homedir(), ".codex", "auth.json");
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Codex CLI public client id

const auth = JSON.parse(fs.readFileSync(AUTH, "utf8"));
if (!auth.tokens?.access_token) throw new Error("no OAuth tokens in ~/.codex/auth.json — run `codex login` first");

const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split(".")[1], "base64url").toString());
if (claims.exp * 1000 - Date.now() < 5 * 60000) {
  const res = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token, scope: "openid profile email" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`token refresh failed (HTTP ${res.status}) — run \`codex login\` to re-authenticate`);
  const t = await res.json();
  auth.tokens.access_token = t.access_token;
  auth.tokens.refresh_token = t.refresh_token ?? auth.tokens.refresh_token;
  if (t.id_token) auth.tokens.id_token = t.id_token;
  auth.last_refresh = new Date().toISOString();
  fs.writeFileSync(AUTH, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

const env = { OPENAI_CODEX_TOKEN: auth.tokens.access_token, OPENAI_CODEX_ACCOUNT: auth.tokens.account_id ?? "" };
const sep = process.argv.indexOf("--");
if (sep >= 0 && process.argv[sep + 1]) {
  const r = spawnSync(process.argv[sep + 1], process.argv.slice(sep + 2), { stdio: "inherit", env: { ...process.env, ...env } });
  process.exit(r.status ?? 1);
}
for (const [k, v] of Object.entries(env)) console.log(`export ${k}='${v}'`);
