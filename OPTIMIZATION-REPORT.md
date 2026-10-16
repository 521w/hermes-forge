# hermes-forge — optimization report

Six defects found, fixed, and each one proven by running the new tests against the
**original** source (`git archive HEAD` into a clean tree) versus the fixed source.

> Defect 6 is a security issue: if you have ever run this server on an untrusted or
> shared network, **rotate the LLM API key** — see that section for the live proof.

## Why this repo

`hermes-forge` is the only substantial codebase among the 10 owned repos (104 tracked
files, JS, Apache-2.0). Its single CI run proves a real, reproducible failure rather
than a hypothetical one: run `34834915719`, job `server-test`, started
`2026-09-14T10:47:25Z`, cancelled `16:48:34Z` — **6 h 1 min**, i.e. GitHub's hard job
limit, on the step `Run server tests`. The suite never exited.

## Defect 1 — streaming tool calls corrupt the payload

`server/src/llm.js`. The accumulator that merges streamed `tool_calls` deltas had a
dead branch:

```js
if (target.function.arguments && target.function.arguments.startsWith(frag)
    && frag.length > target.function.arguments.length)   // never true
```

`startsWith(frag)` requires the held buffer to begin with the new fragment, while
`frag.length > held.length` requires the opposite — so a provider that resends the
full buffer each chunk was never detected, and `{"exp` + `{"expression":...}`
concatenated into invalid JSON. The tool call then failed to parse and the agent loop
died on round 1. The same bug hit `function.name` (`calculatecalculate`).

Fixed by exporting `applyToolDelta` with a correct discriminator (a fragment that
starts with what we hold **and** is at least as long is a resend → replace, otherwise
append), and by covering it with unit tests plus two end-to-end streaming tests
against the mock.

## Defect 2 — sandbox escapes

`server/src/tools.js`. `run_js` built its context with a plain object and injected host
objects, so the classic constructor chain reached the host realm:

```
this.constructor.constructor("return process")()          → host process
console.log.constructor("return process")()               → host process
[].constructor.constructor("return process")()            → host process
Object.getPrototypeOf(console.log).constructor(...)       → host process
```

Any model-authored expression could read the host environment, the API key in
`process.env`, and the filesystem. Fixed with a null-prototype sandbox, no injected
host objects, a realm-local `console`, and
`vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })`.

## Defect 3 — dynamic import terminates the host

Inside a vm context, `import()` has no callback and aborts the process with
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` (exit 1) — not catchable, not a rejected
promise. Fixed with a lexical rejection (`assertNoDynamicImport`) that ignores
`import` in strings and comments, so legitimate code is unaffected.

## Defect 4 — an unhandled rejection in the sandbox killed the server

The sandbox had no rejection guard, so `run_js` evaluating `Promise.reject(...)`
brought down the whole server. Fixed by recording sandbox rejections and appending
them to the tool result. Discrimination uses the realm: `promise instanceof Promise`
is false for vm promises and true for host promises, so host rejections are still
rethrown rather than swallowed. `safeEval` is async and waits one `setImmediate` tick,
because `unhandledRejection` only fires after the microtask queue drains.

## Defect 5 — no graceful shutdown, and a failed boot exited 0

`server/src/index.js` registered no `SIGTERM`/`SIGINT` handler and never called
`server.close()`, so Ctrl-C left the port occupied. Worse, an `EADDRINUSE` crash
exited with code **0**, telling CI and process managers that a failed start was a
clean shutdown. Fixed with a `shutdown(signal, exitCode)` path, a 5 s unref'd force
timer, and `shutdown("uncaughtException", 1)`.

## Defect 6 — any caller can read, overwrite and delete files outside the sessions directory (path traversal)

The most serious defect, and the one with a working exploit. `GET|PATCH|DELETE
/api/sessions/:id` passed the raw URL parameter into a filesystem path:

```js
// server/src/store.js — original
function fileFor(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);   // `id` is attacker-controlled
}
```

Express percent-decodes the parameter *before* the handler runs, so `%2F` becomes a
real `/` and `%2E%2E` becomes `..`. Nothing validated the id, and the delete route
even rebuilt the same unsafe path inline in `index.js`. The server calls
`app.listen(port)` with no host argument, so it binds every interface — on a LAN this
is unauthenticated remote file access, and the README invites exactly that setup.

Live probe against a running server (canary files placed where `settings.json`
lives, i.e. one directory above the sessions directory):

| Request | Result |
| --- | --- |
| `GET /api/sessions/..%2F..%2F..%2Fsecret` | **200** — returned a file from outside `sessions/`, verbatim |
| `PATCH …/..%2Fcanary-secret` | **200** — injected `"pwned":"yes"` into that outside file |
| `DELETE …/..%2Fcanary-secret` | **200** `{"ok":true}` — the outside file **was deleted** |
| `GET /api/sessions/..%2Fsettings` | **200** — returned `{"llmApiKey":"sk-…"}` in plaintext |
| `GET /api/settings` (same server) | key correctly masked as `hasKey: true` |

That last pair is the escalation that matters: the settings endpoint goes out of its
way to hide the key, and this route handed it over anyway. Any `.json` file reachable
by the server process was readable, writable and deletable.

Fixed in two layers, so the invariant holds no matter which route is added later:

- `store.js` — `isValidSessionId()` accepts only `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`
  with no `..`, and `fileFor()` **throws** on anything else. Every store function goes
  through `fileFor`, so the whole module is safe by construction. `deleteSession()`
  moved into the store (the route previously duplicated the unsafe path join), and
  `patchSession()` now applies only `title` instead of `Object.assign`-ing the whole
  request body — that was a second bug in the same handler, letting `PATCH` rewrite the
  session `id` and inject arbitrary `messages`.
- `index.js` — each route validates the id first and answers `400 invalid session id`;
  `deleteSession` returns `404` when nothing was removed. `POST /api/chat` applies the
  same check to its `sessionId` field, which also flowed into `appendMessage`.

`GET /download/:file` was already correct (`path.basename`), which is what makes this
an oversight rather than a design choice.

Proven necessary: the new `server/test/session-security.test.mjs` against the original
source is **1 passed, 6 failed** (canary read, overwritten and deleted; `PATCH`
returned `id: "hijacked"`), and **7 passed, 0 failed** after the fix.

## The CI hang

`npm test` was `node --test test/`, and `node --test` with no file arguments collects
**every** `.mjs` under `test/` — including `test/mock-llm.mjs`, a server that is
supposed to stay up. It was executed as a test, never exited, and burned the full
6-hour job limit. `--test-timeout` does not contain it.

Fixed three ways: the mock moved to `server/mocks/` (which the runner does not
collect), `test` now globs `test/*.test.mjs` (unquoted, so the shell expands it —
Node 20's `--test` does not expand globs itself), and the workflow gained
`timeout-minutes` on both the job and the test step. CI also switched from
`npm install` to `npm ci` against the committed lockfile, with npm caching.

## Evidence

| Check | Original source | Fixed source |
| --- | --- | --- |
| `llm-stream.test.mjs` | `SyntaxError: no export named 'applyToolDelta'` | 7 passed, 0 failed |
| `sandbox.test.mjs` | 5 passed, **13 failed** | 18 passed, 0 failed |
| `session-security.test.mjs` | 1 passed, **6 failed** (canary leaked/deleted) | 7 passed, 0 failed |
| `e2e-chat-sse.test.mjs` | file did not exist (`POST /api/chat` over HTTP untested) | 8 passed, 0 failed |
| bare `node --test` (the CI command) | hung, killed at 90 s (exit 124) | 5 files, 0 failed, 7 s |
| `server-lifecycle.test.mjs` | file did not exist | 4 passed, 0 failed, 0 skipped |
| `tools.test.mjs` (baseline, unchanged) | 31 checks passed | 31 checks passed |

Full suite from `server/`: `node --test test/*.test.mjs` → **7 files, 7 passed,
0 failed, 0 cancelled, ~7 s**, exit 0.

`server-lifecycle.test.mjs` resolves `express` via `import.meta.resolve` rather than
checking `server/node_modules`, because npm workspaces hoist it to the repo root;
verified by moving `node_modules` to the root — 4 passed, 0 skipped.

## Also changed

- `README.md` — added a **Tests** section (`npm test`, `npm run mock`, why the mock is
  not under `test/`), documented the `PORT` inheritance trap, and updated the project
  layout.
- `.monkeycode/MEMORY.md` — corrected two stale bullets (the old
  `node server/test/tools.test.mjs` command and the mock's location) and recorded the
  test-collection rule that caused the hang.

## Not changed

No dependency was added. No production behaviour beyond the six defects was touched;
`tools.test.mjs` and `agent-loop.test.mjs` pass unmodified.
