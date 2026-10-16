# hermes-forge — optimization report

Five defects found, fixed, and each one proven by running the new tests against the
**original** source (`git archive HEAD` into a clean tree) versus the fixed source.

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
| bare `node --test` (the CI command) | hung, killed at 90 s (exit 124) | 5 files, 0 failed, 7 s |
| `server-lifecycle.test.mjs` | file did not exist | 4 passed, 0 failed, 0 skipped |
| `tools.test.mjs` (baseline, unchanged) | 31 checks passed | 31 checks passed |

Full suite from `server/`: `node --test test/*.test.mjs` → **5 files, 5 passed,
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

No dependency was added. No production behaviour beyond the five defects was touched;
`tools.test.mjs` and `agent-loop.test.mjs` pass unmodified.
