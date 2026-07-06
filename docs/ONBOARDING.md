# Onboarding — from zero to a governed run

Prerequisites: Node ≥ 18 (or Deno), `python3` for the validator and tests.
Nothing to install — the agent is one file with zero dependencies.

## 1. Pick your auth mode (the "switch")

Auth is selected **per endpoint in the manifest**, not globally — the
`provider` field plus an optional `auth` block is the switch. A manifest can
mix modes freely; the weight grid treats them all as peers.

| Mode | Manifest switch | Credential source | Best for |
|------|-----------------|-------------------|----------|
| API key | `"provider": "anthropic" \| "openai" \| "gemini"` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` env | Fastest start; metered platform billing |
| ChatGPT-plan OAuth | `"provider": "codex"` | `~/.codex/auth.json` via `scripts/codex_env.mjs` | Riding an existing ChatGPT subscription |
| OAuth2 client-credentials | any provider + `"auth": {...}` block | Token endpoint; secrets in env vars the block names | Azure OpenAI, corporate gateways, SSO shops |
| Mock | `"provider": "mock"` | none | Offline tests and dry rehearsals |

## 2. Onboard your chosen mode

### A. API keys — 2 minutes

```bash
export ANTHROPIC_API_KEY=...        # any subset of the three
export OPENAI_API_KEY=...
export GEMINI_API_KEY=...
```

Endpoints without a usable credential are simply excluded from the grid at
runtime — declare all three in the manifest and set whichever keys you have.

### B. ChatGPT-plan OAuth (Codex) — one-time browser login

1. Install Codex CLI and sign in once (the only interactive step, ever):
   ```bash
   npm i -g @openai/codex && codex login
   ```
   This mints `~/.codex/auth.json`. (Already have OpenClaw or Codex on the
   machine? Skip this — the session is already there. Or copy a valid
   `auth.json` from another machine.)
2. From then on, run the agent through the credential helper, which reads
   that file and auto-refreshes the token near expiry — no browser, no
   OpenClaw, no codex binary needed at runtime:
   ```bash
   node scripts/codex_env.mjs -- node agent.mjs manifest.json --apply
   ```
3. Manifest endpoint: `{"name": "openai-codex", "provider": "codex",
   "model": "gpt-5.5"}`.

Troubleshooting: `codex HTTP 401` in the trace → session revoked, run
`codex login` again. `token refresh failed` from the helper → same fix.
Caveat: this is an unofficial subscription surface — keep it as one endpoint
among peers, never the only one, for work that must be stable.

### C. OAuth2 client-credentials — machine-to-machine

1. Obtain a client ID/secret from your identity provider (for Azure OpenAI:
   an Entra ID app registration with the *Cognitive Services OpenAI User*
   role on the resource).
2. Export the secrets under names of your choosing:
   ```bash
   export MY_LLM_CLIENT_ID=...
   export MY_LLM_CLIENT_SECRET=...
   ```
3. Point the endpoint's `auth` block at them — the manifest names env
   variables, never values, and the validator rejects anything that looks
   like a pasted secret:
   ```json
   {
     "name": "azure-openai", "provider": "openai", "model": "<deployment>",
     "baseUrl": "https://<resource>.openai.azure.com/openai",
     "auth": {
       "type": "oauth2-client-credentials",
       "tokenUrl": "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token",
       "clientIdEnv": "MY_LLM_CLIENT_ID",
       "clientSecretEnv": "MY_LLM_CLIENT_SECRET",
       "scope": "https://cognitiveservices.azure.com/.default"
     }
   }
   ```

Tokens are cached and refreshed automatically; a token failure fails over to
the next endpoint like any transport error.

## 3. Verify before first real work

```bash
python3 scripts/validate_task.py your-manifest.json   # TASK_OK?
python3 tests/test_m0.py                              # 11 offline floor tests
node agent.mjs your-manifest.json                     # dry-run (default)
```

Dry-run exercises the full loop — model calls included — but records writes
and commands without applying them. Inspect what *would* have happened in
`<workspace>/.sfma/trace.jsonl`, then run with `--apply`.

## 4. Where things land

Every run writes, inside the workspace only:

- `.sfma/trace.jsonl` — append-only event log (every call, verdict, write)
- `.sfma/result.json` — the result record: bootstrap, criteria, endpoint
  weights, verdict

Keys, tenant IDs, and live manifests belong in your private downstream fork
(SPEC §10) — this public repo stays synthetic.
