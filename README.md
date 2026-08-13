# Hermes Forge

An agentic workbench built to be **fully compatible with the Hermes model family** (Nous Research) and go beyond it — with multi-agent crew orchestration, built-in tool execution, persistent long-term memory, and a streaming, real-time UI.

## What makes it more than Hermes

- **OpenAI-compatible client** (`server/src/llm.js`): works with any Hermes endpoint (OpenRouter, Nous NIM, vLLM, etc.) including streaming and native tool-calling deltas.
- **Two run modes**:
  - `Agent` — single-agent agentic loop with tool calls (Hermes native behavior, enhanced).
  - `Crew` — Planner → Executor → Reviewer multi-agent pipeline with an explicit, structured **plan / todo list**, live todo progress, and a reviewer verdict surfaced in the UI.
- **Built-in tools** (`server/src/tools.js`): math `calculate`, `get_current_time`, sandboxed `run_js` (node:vm), workspace file tools (`read_file`, `write_file`, `list_dir`, `grep_files`), `web_fetch`, long-term `memory_store` / `memory_recall` **and full-text `memory_search`** across sessions, and `fibonacci`.
- **Persistent sessions** (`server/src/store.js`) stored as JSON under `server/data/`.
- **Streaming UI**: SSE events drive token-by-token rendering, collapsible tool-call cards with syntax highlighting, a Claude Code-style plan/todo panel, and reviewer verdicts in real time.

## Stack

- Backend: Node.js + Express (no framework lock-in; pure `fetch` to the LLM API).
- Frontend: Vite + React + TypeScript, `react-markdown` for rendering.

## Run

```bash
npm install

# 1. configure
cp .env.example .env   # set USER_LLM_BASE_URL, USER_LLM_API_KEY, USER_LLM_MODEL

# 2. build frontend
npm run build -w web

# 3. serve (API + static frontend on :3001)
npm start
```

Open http://localhost:3001 (or configure the model endpoint in the in-app **Settings** panel).

## Config

All settings are user-facing env vars (`.env` / `.env.example`) or editable in-app:

| Variable | Default |
| --- | --- |
| `USER_LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `USER_LLM_API_KEY` | *(empty)* |
| `USER_LLM_MODEL` | `nousresearch/hermes-4-405b` |
| `USER_AGENT_SYSTEM` | default system prompt |
| `USER_MAX_TOKENS` | `4096` |
| `USER_TEMPERATURE` | `0.7` |
| `PORT` | `3001` |

## Android app

Hermes Forge ships as an Android APK built with Capacitor. The app runs fully locally (LLM calls, tools and memory execute inside the app; sessions persist in local storage) — point it at any OpenAI-compatible Hermes endpoint in Settings.

```bash
cd web
npm install
npx cap add android            # once
npx vite build && npx cap sync android

cd android
echo "sdk.dir=/opt/android-sdk" > local.properties   # adjust to your SDK path
export ANDROID_HOME=/opt/android-sdk

# debug (unsigned, installable on device)
./gradlew assembleDebug
# output: android/app/build/outputs/apk/debug/app-debug.apk

# release (signed with android/keystore/hermes-forge.keystore)
./gradlew assembleRelease
# output: android/app/build/outputs/apk/release/app-release.apk
```

The signed release APK is also downloadable from the web app: `https://<your-host>/download/hermes-forge-v1.0.apk`.

On a phone, `127.0.0.1` points to the phone itself — use your computer's LAN IP or a public URL for the model endpoint.

## Project layout

```
server/src/
  index.js    Express API + SSE /api/chat + static hosting
  llm.js      Hermes-compatible streaming client
  agents.js   Single-agent loop + Planner/Executor/Reviewer crew
  tools.js    Tool registry & sandboxed executors
  store.js    Session persistence
  config.js   Settings/env
web/src/
  App.tsx                Workspace shell (sidebar, composer, modes)
  components/MessageBubble.tsx
  api.ts                 SSE streaming client
```
