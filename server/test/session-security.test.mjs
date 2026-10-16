// Regression tests for session-id handling in the HTTP API.
//
// Before this, `GET|PATCH|DELETE /api/sessions/:id` joined the raw URL parameter
// straight into a filesystem path, and Express decodes `%2F` before the handler
// runs — so an id of `..%2Fsettings` escaped `server/data/sessions/` and let any
// caller read, overwrite and delete arbitrary `.json` files. The worst case was
// `GET /api/sessions/..%2Fsettings`, which returned the stored LLM API key in
// plaintext even though `GET /api/settings` deliberately masks it as `hasKey`.
//
// The canary below lives outside the sessions directory, exactly where
// settings.json does, so these tests fail loudly if the traversal returns.
// Express is only installed by `npm ci`, so the whole file skips cleanly in a
// bare checkout instead of failing.
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
const DATA_DIR = path.join(SERVER_DIR, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

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
const PORT = 3466;
const BASE = `http://127.0.0.1:${PORT}`;

// One level above SESSIONS_DIR — the same place settings.json (and the API key)
// is kept, so this canary stands in for the real secret.
const CANARY = path.join(DATA_DIR, "canary-secret.json");
const CANARY_ID = "..%2Fcanary-secret";
const CANARY_TEXT = '{"llmApiKey":"sk-CANARY-MUST-NOT-ESCAPE"}';

let child = null;
let output = "";
const createdIds = [];

async function startServer() {
  requireExpress();
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(CANARY, CANARY_TEXT, "utf-8");
  child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server never became healthy: ${output}`);
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r)).catch(() => {});
  }
  child = null;
}

function cleanup() {
  try {
    fs.rmSync(CANARY);
  } catch {
    /* already gone */
  }
  for (const id of createdIds) {
    try {
      fs.rmSync(path.join(SESSIONS_DIR, `${id}.json`));
    } catch {
      /* already gone */
    }
  }
}

await startServer();

try {
  await test("sessions: a traversing id cannot read outside the sessions dir", async () => {
    const res = await fetch(`${BASE}/api/sessions/${CANARY_ID}`);
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes("sk-CANARY"), `canary secret leaked: ${body}`);
  });

  await test("sessions: a traversing id cannot overwrite a file outside the sessions dir", async () => {
    const res = await fetch(`${BASE}/api/sessions/${CANARY_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "pwned" }),
    });
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.strictEqual(fs.readFileSync(CANARY, "utf-8"), CANARY_TEXT, "canary file was modified");
  });

  await test("sessions: a traversing id cannot delete a file outside the sessions dir", async () => {
    const res = await fetch(`${BASE}/api/sessions/${CANARY_ID}`, { method: "DELETE" });
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.ok(fs.existsSync(CANARY), "canary file was deleted");
  });

  await test("sessions: other malformed ids are rejected too", async () => {
    // Encoded separators, dotfiles, over-long ids, NUL and doubled dots all have
    // to be refused by the handler itself.
    const ids = ["..%2F..%2Fsettings", "a%2Fb", ".hidden", "x".repeat(80), "%00", "%2e%2e%2fsettings", "....%2f%2fsettings", "%2Fetc%2Fpasswd"];
    for (const id of ids) {
      const res = await fetch(`${BASE}/api/sessions/${id}`);
      assert.strictEqual(res.status, 400, `id ${id} should be rejected, got ${res.status}`);
    }

    // A bare `..` never reaches the server: the HTTP client normalises it out of
    // the path first, so it lands on the static-handler 404. Assert only that it
    // does not leak anything, rather than pinning a status this code cannot own.
    for (const id of ["..", "%2E%2E"]) {
      const res = await fetch(`${BASE}/api/sessions/${id}`);
      assert.ok(res.status === 400 || res.status === 404, `id ${id} gave ${res.status}`);
      assert.ok(!(await res.text()).includes("sk-CANARY"), `id ${id} leaked the canary`);
    }
  });

  await test("sessions: the settings file itself is not reachable via the sessions API", async () => {
    const res = await fetch(`${BASE}/api/sessions/..%2Fsettings`);
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
  });

  await test("sessions: a legitimate id still round-trips", async () => {
    const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json();
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    createdIds.push(created.id);

    const got = await fetch(`${BASE}/api/sessions/${created.id}`);
    assert.strictEqual(got.status, 200);
    assert.strictEqual((await got.json()).id, created.id);

    const renamed = await (
      await fetch(`${BASE}/api/sessions/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      })
    ).json();
    assert.strictEqual(renamed.title, "Renamed");

    const deleted = await fetch(`${BASE}/api/sessions/${created.id}`, { method: "DELETE" });
    assert.strictEqual(deleted.status, 200);
    assert.strictEqual((await deleted.json()).ok, true);
    assert.strictEqual((await fetch(`${BASE}/api/sessions/${created.id}`)).status, 404);
  });

  await test("sessions: PATCH cannot overwrite the id or the message history", async () => {
    const created = await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json();
    createdIds.push(created.id);

    const patched = await (
      await fetch(`${BASE}/api/sessions/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "hijacked", messages: [{ role: "user", content: "injected" }] }),
      })
    ).json();

    assert.strictEqual(patched.id, created.id, "PATCH must not rewrite the session id");
    assert.deepStrictEqual(patched.messages, [], "PATCH must not inject messages");
  });
} finally {
  await stopServer();
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
