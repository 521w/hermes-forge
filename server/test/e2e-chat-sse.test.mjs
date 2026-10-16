// End-to-end tests for the live HTTP + SSE chat endpoint.
//
// Nothing else in this suite touches `POST /api/chat` over real HTTP: the
// agent-loop and llm-stream tests drive the modules in-process, and the other
// HTTP tests only exercise session CRUD. That left the single most important
// surface of the product — the streamed chat response a browser actually
// consumes — completely unverified. These tests boot the real server and the
// mock LLM as separate processes, speak HTTP to them, and read the raw
// `event: X\ndata: {json}\n\n` frames off the socket.
//
// What they lock down:
//   * `Content-Type: text/event-stream` and the frame grammar itself;
//   * single mode: tool call round-trip (`tool_start` -> `tool_result`), the
//     final answer deltas, and the terminating `done` frame;
//   * the assistant turn is actually persisted, not just streamed;
//   * crew mode: the planning/executing/todo/reviewing/done phase ladder
//     including the todo-state machine around each tool call;
//   * both 400 paths (missing `message`, malformed JSON) that need no LLM.
//
// Express is only installed by `npm ci`, so the file skips cleanly in a bare
// checkout instead of failing.

import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    if (err && err.code === "SKIP") {
      skipped++;
      console.log(`SKIP  ${name} (${err.message})`);
      return;
    }
    fail++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, "..");
const SESSIONS_DIR = path.join(SERVER_DIR, "data", "sessions");

function requireExpress() {
  try {
    import.meta.resolve("express");
  } catch {
    const err = new Error("express not installed; run npm ci first");
    err.code = "SKIP";
    throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Both ports are explicit: the mock defaults to 3999 and the server defaults to
// 3001 (or whatever the shell exported), so neither is safe to inherit.
const MOCK_PORT = 3987;
const APP_PORT = 3487;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;

// Any single HTTP request in this suite is short; if one hangs, the watchdog
// below is what turns it into a failure instead of a stuck run.
const REQUEST_TIMEOUT_MS = 15_000;
const WATCHDOG_MS = 90_000;

let mock = null;
let app = null;
let mockOutput = "";
let appOutput = "";
const createdIds = [];

async function startMock() {
  mock = spawn(process.execPath, ["mocks/mock-llm.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, MOCK_LLM_PORT: String(MOCK_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  mock.stdout.on("data", (d) => (mockOutput += d));
  mock.stderr.on("data", (d) => (mockOutput += d));

  // The mock answers 404 to anything but POST /chat/completions, which is all
  // we need: any HTTP response proves the socket is bound and serving.
  for (let i = 0; i < 60; i++) {
    if (mock.exitCode !== null) throw new Error(`mock-llm exited early: ${mockOutput}`);
    try {
      await fetch(`${MOCK_BASE}/`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`mock-llm never became reachable: ${mockOutput}`);
}

async function startApp() {
  requireExpress();
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  app = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      // No trailing /v1: the client appends /chat/completions itself and the
      // mock matches that exact path.
      USER_LLM_BASE_URL: MOCK_BASE,
      USER_LLM_API_KEY: "test-key",
      USER_LLM_MODEL: "mock-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => (appOutput += d));
  app.stderr.on("data", (d) => (appOutput += d));

  // Readiness is polled, never a fixed sleep, so a slow boot cannot flake and a
  // fast one does not waste time.
  for (let i = 0; i < 60; i++) {
    if (app.exitCode !== null) throw new Error(`server exited early: ${appOutput}`);
    try {
      const res = await fetch(`${APP_BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server never became healthy: ${appOutput}`);
}

function kill(child) {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function stopAll() {
  kill(mock);
  kill(app);
  // SIGKILL has no graceful handler, so the exit is immediate; the single tick
  // just lets the OS reap both before the ports are reused or asserted on.
  await sleep(200);
  mock = null;
  app = null;
}

function cleanup() {
  for (const id of createdIds) {
    try {
      fs.rmSync(path.join(SESSIONS_DIR, `${id}.json`));
    } catch {
      /* already gone */
    }
  }
}

// --- SSE helpers -----------------------------------------------------------

// The wire format is `event: <name>\ndata: <json>\n\n`; blank lines separate
// frames and the server never writes a comment heartbeat, so a split on the
// blank line is enough.
function parseFrames(raw) {
  const frames = [];
  for (const block of raw.split("\n\n")) {
    const name = /^event: (.+)$/m.exec(block);
    if (!name) continue;
    const data = /^data: (.*)$/m.exec(block);
    frames.push({
      event: name[1].trim(),
      data: data ? JSON.parse(data[1]) : null,
    });
  }
  return frames;
}

async function postChat(body, { raw = false } = {}) {
  const res = await fetch(`${APP_BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res;
}

async function chat(body) {
  const res = await postChat(body);
  const raw = await res.text();
  const frames = parseFrames(raw);
  const session = frames.find((f) => f.event === "session");
  if (session?.data?.sessionId) createdIds.push(session.data.sessionId);
  return { res, raw, frames };
}

const names = (frames) => frames.map((f) => f.event);
const firstIndex = (frames, event) => frames.findIndex((f) => f.event === event);
const phaseIndex = (frames, phase) =>
  frames.findIndex((f) => f.event === "phase" && f.data?.phase === phase);
const phasesOf = (frames) =>
  frames.filter((f) => f.event === "phase").map((f) => f.data?.phase);

function assertOrdered(frames, pairs) {
  for (const [before, after] of pairs) {
    const b = firstIndex(frames, before);
    const a = firstIndex(frames, after);
    assert.ok(b !== -1, `expected an "${before}" frame; saw: ${names(frames).join(", ")}`);
    assert.ok(a !== -1, `expected an "${after}" frame; saw: ${names(frames).join(", ")}`);
    assert.ok(b < a, `expected "${before}" (at ${b}) before "${after}" (at ${a})`);
  }
}

const watchdog = setTimeout(() => {
  console.error(`\nFAIL  overall: chat SSE suite timed out after ${WATCHDOG_MS}ms`);
  console.error(`      app output: ${appOutput.slice(-500)}`);
  console.error(`      mock output: ${mockOutput.slice(-300)}`);
  // process.exit() skips the `finally` block below, so the children must be
  // reaped here or they outlive the runner and leak as orphans.
  kill(mock);
  kill(app);
  process.exit(1);
}, WATCHDOG_MS);

// A boot failure (most likely a missing express) is captured here and replayed
// per test, so an incomplete checkout reports SKIP lines and exits 0 instead of
// crashing the runner with an unhandled rejection.
let bootError = null;

try {
  try {
    await startMock();
    await startApp();
  } catch (err) {
    bootError = err;
  }

  const requireBoot = () => {
    if (bootError) throw bootError;
  };

  // --- Case A: single mode, one tool call then the final answer ------------

  await test("chat/single: streams SSE frames for a tool call and the final answer", async () => {
    requireBoot();
    const { res, frames } = await chat({ message: "What is 6*7?", mode: "single" });

    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert.match(
      res.headers.get("content-type") || "",
      /^text\/event-stream/,
      `expected an SSE content type, got ${res.headers.get("content-type")}`,
    );

    // The first frame must identify the session the turn is being written to.
    assert.strictEqual(frames[0]?.event, "session", `first frame was ${frames[0]?.event}`);
    assert.strictEqual(typeof frames[0].data.sessionId, "string");
    assert.ok(frames[0].data.sessionId.length > 0, "session frame had an empty sessionId");

    // The tool round-trip: the mock streams a fragmented `calculate` call, so
    // the assembled call must survive the deltas and be executed for real.
    assertOrdered(frames, [["tool_start", "tool_result"], ["tool_result", "done"]]);

    const start = frames.find((f) => f.event === "tool_start");
    assert.strictEqual(start.data.name, "calculate");
    // `arguments` crosses the wire as the raw JSON string, not an object.
    assert.strictEqual(typeof start.data.arguments, "string", "tool_start.arguments must be a string");
    assert.deepStrictEqual(JSON.parse(start.data.arguments), { expression: "6 * 7" });

    const result = frames.find((f) => f.event === "tool_result");
    assert.strictEqual(result.data.name, "calculate");
    assert.strictEqual(result.data.result, "42", "calculate(6 * 7) must execute to 42");

    // Fragmented tool-call deltas are part of the streaming contract.
    assert.ok(
      frames.some((f) => f.event === "tool_delta"),
      `expected at least one tool_delta frame; saw: ${names(frames).join(", ")}`,
    );

    const answer = frames
      .filter((f) => f.event === "delta")
      .map((f) => f.data.text)
      .join("");
    assert.strictEqual(answer, "The answer is 42");

    // `done` terminates the stream and carries the persisted session identity.
    const done = frames[frames.length - 1];
    assert.strictEqual(done.event, "done", `last frame was ${done.event}`);
    assert.strictEqual(done.data.sessionId, frames[0].data.sessionId);
    assert.ok(done.data.title, "done frame should carry the session title");
    assert.ok(
      !frames.some((f) => f.event === "error"),
      `stream reported an error: ${JSON.stringify(frames.find((f) => f.event === "error")?.data)}`,
    );
  });

  await test("chat/single: persists the assistant turn for the streamed answer", async () => {
    requireBoot();
    const { frames } = await chat({ message: "Persist me", mode: "single" });
    const sessionId = frames[0].data.sessionId;

    const res = await fetch(`${APP_BASE}/api/sessions/${sessionId}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.strictEqual(res.status, 200, `expected 200 reading back the session, got ${res.status}`);
    const session = await res.json();

    assert.strictEqual(session.messages.length, 2, "expected exactly the user turn and the assistant turn");
    assert.strictEqual(session.messages[0].role, "user");
    assert.strictEqual(session.messages[0].content, "Persist me");

    const assistant = session.messages[1];
    assert.strictEqual(assistant.role, "assistant");
    assert.strictEqual(assistant.content, "The answer is 42", "the streamed text must be what is stored");
    assert.strictEqual(assistant.mode, "single");
    assert.ok(
      Array.isArray(assistant.meta?.toolCalls) && assistant.meta.toolCalls.length >= 1,
      `expected the tool call in meta.toolCalls, got ${JSON.stringify(assistant.meta)}`,
    );
  });

  // --- Case B: crew mode, the full phase ladder ----------------------------

  await test("chat/crew: emits the planning/executing/todo/reviewing/done phases and a verdict", async () => {
    const { res, frames } = await chat({ message: "What is 6*7?", mode: "crew" });

    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert.match(
      res.headers.get("content-type") || "",
      /^text\/event-stream/,
      `expected an SSE content type, got ${res.headers.get("content-type")}`,
    );

    const phases = phasesOf(frames);
    for (const expected of ["planning", "executing", "todo", "reviewing", "done"]) {
      assert.ok(phases.includes(expected), `missing "${expected}" phase; saw: ${phases.join(", ")}`);
    }
    assert.ok(
      phaseIndex(frames, "planning") < phaseIndex(frames, "executing"),
      "planning must precede executing",
    );
    assert.ok(
      phaseIndex(frames, "executing") < phaseIndex(frames, "todo"),
      "executing must precede the first todo update",
    );
    assert.ok(
      phaseIndex(frames, "reviewing") < phaseIndex(frames, "done"),
      "reviewing must precede the terminal done phase",
    );

    // The plan drives the todo list, and the executor marks each item as it
    // runs, so at least one tool call must be bracketed by todo updates.
    const executing = frames.find((f) => f.event === "phase" && f.data.phase === "executing");
    assert.strictEqual(typeof executing.data.plan, "string");
    assert.ok(executing.data.plan.length > 0, "executing phase carried an empty plan");
    assert.ok(
      Array.isArray(executing.data.todos) && executing.data.todos.length > 0,
      `expected a non-empty todo list, got ${JSON.stringify(executing.data.todos)}`,
    );

    assertOrdered(frames, [["tool_start", "tool_result"]]);

    const todoStates = frames
      .filter((f) => f.event === "phase" && f.data.phase === "todo")
      .map((f) => f.data.todoState);
    assert.ok(todoStates.length > 0, "expected todo-state updates around the tool call");
    for (const state of todoStates) {
      assert.ok(Array.isArray(state), `todoState should be an array, got ${JSON.stringify(state)}`);
    }
    assert.ok(
      todoStates.some((s) => s.includes("running")),
      `expected a todo to be marked running; saw: ${JSON.stringify(todoStates)}`,
    );
    assert.ok(
      todoStates.some((s) => s.every((t) => t === "done")),
      `expected every todo to end up done; saw: ${JSON.stringify(todoStates)}`,
    );

    // The reviewer's verdict travels on the terminal phase frame. Only that it
    // is a non-empty string is asserted: the mock answers text-only requests
    // with the planning text, so the value is mock-shaped, not product logic.
    const donePhase = frames.find((f) => f.event === "phase" && f.data.phase === "done");
    assert.strictEqual(typeof donePhase.data.verdict, "string");
    assert.ok(donePhase.data.verdict.trim().length > 0, "done phase carried an empty verdict");

    const done = frames[frames.length - 1];
    assert.strictEqual(done.event, "done", `last frame was ${done.event}`);
    assert.strictEqual(done.data.sessionId, frames[0].data.sessionId);
    assert.ok(
      !frames.some((f) => f.event === "error"),
      `stream reported an error: ${JSON.stringify(frames.find((f) => f.event === "error")?.data)}`,
    );
  });

  await test("chat/crew: persists the plan, verdict and todos with the assistant turn", async () => {
    const { frames } = await chat({ message: "Crew persist", mode: "crew" });
    const sessionId = frames[0].data.sessionId;

    const res = await fetch(`${APP_BASE}/api/sessions/${sessionId}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.strictEqual(res.status, 200);
    const session = await res.json();

    const assistant = session.messages[1];
    assert.strictEqual(assistant.role, "assistant");
    assert.strictEqual(assistant.mode, "crew");
    assert.strictEqual(assistant.content, "The answer is 42");
    assert.strictEqual(typeof assistant.meta?.plan, "string");
    assert.strictEqual(typeof assistant.meta?.verdict, "string");
    assert.ok(Array.isArray(assistant.meta?.todos), `expected meta.todos, got ${JSON.stringify(assistant.meta)}`);
  });

  // --- Case C: the 400s that need no LLM ----------------------------------

  await test("chat: rejects a request with no message", async () => {
    const res = await postChat({ mode: "single" });

    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.deepStrictEqual(await res.json(), { error: "message is required" });
  });

  await test("chat: rejects a whitespace-only message", async () => {
    const res = await postChat({ message: "   ", mode: "single" });

    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.deepStrictEqual(await res.json(), { error: "message is required" });
  });

  await test("chat: rejects a malformed JSON body", async () => {
    const res = await postChat("{not json", { raw: true });

    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.deepStrictEqual(await res.json(), { error: "Invalid JSON in request body." });
  });

  await test("chat: the 400 paths never open an SSE stream", async () => {
    const res = await postChat({ mode: "single" });

    assert.strictEqual(res.status, 400);
    assert.ok(
      !(res.headers.get("content-type") || "").includes("text/event-stream"),
      `error responses must stay JSON, got ${res.headers.get("content-type")}`,
    );
  });
} finally {
  clearTimeout(watchdog);
  await stopAll();
  cleanup();
}

const leftover = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : [];
if (leftover.length > 0) {
  fail++;
  console.log(`FAIL  cleanup: session files left behind: ${leftover.join(", ")}`);
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
