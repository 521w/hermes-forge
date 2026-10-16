// Regression tests for the HTTP server's process lifecycle.
//
// Before this, `src/index.js` registered no SIGTERM/SIGINT handler and no
// `server.close()`, so Ctrl-C on `npm run dev` left the port occupied
// (EADDRINUSE on the next start) and a crashed boot still reported exit 0,
// which makes CI and process managers treat a failure as a clean shutdown.
//
// The server is exercised in child processes so that signals and exit codes are
// observable. Express is only installed by `npm ci`, so the whole file skips
// cleanly in a bare checkout instead of failing.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
const INDEX = path.join(SERVER_DIR, "src", "index.js");

function requireExpress() {
  // Mirror Node's own resolution instead of checking one directory: under npm
  // workspaces `express` hoists into the repo-root node_modules, so a
  // server/node_modules existence check would wrongly skip this file in CI.
  try {
    import.meta.resolve("express");
  } catch {
    const err = new Error("express not installed; run npm ci first");
    err.code = "SKIP";
    throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawns the server, waits for it to boot, then runs `onStarted`, and returns
// { code, signal, output } once it exits.
async function withServer(env, onStarted) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await sleep(1500);
  await onStarted(child);
  const result = await Promise.race([exited, sleep(9000).then(() => null)]);
  if (result) return { ...result, output };
  child.kill("SIGKILL");
  await exited;
  return { code: "timeout", signal: null, output };
}

await test("index.js: serves /api/health and exits 0 on SIGTERM", async () => {
  requireExpress();
  const port = 3461;
  const r = await withServer({ PORT: String(port) }, async (child) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json().then((b) => b.ok), true);
    child.kill("SIGTERM");
  });
  assert.strictEqual(r.code, 0, `expected a clean exit, got ${JSON.stringify(r)}\n${r.output}`);
  assert.match(r.output, /SIGTERM received/);
});

await test("index.js: releases the port on shutdown", async () => {
  requireExpress();
  const port = 3462;
  const r = await withServer({ PORT: String(port) }, async (child) => {
    await sleep(200);
    child.kill("SIGTERM");
  });
  assert.strictEqual(r.code, 0, `exit ${JSON.stringify(r)}\n${r.output}`);
  // The port must be free again: bind it ourselves.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (err) => reject(new Error(`port still held: ${err.code}`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
});

await test("index.js: a failed boot exits non-zero", async () => {
  requireExpress();
  const port = 3463;
  // Squat the port so the server's own listen() fails with EADDRINUSE.
  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  try {
    const r = await withServer({ PORT: String(port) }, async (child) => {
      await sleep(300);
      child.kill("SIGKILL"); // only if it wrongly stayed alive
    });
    assert.strictEqual(r.code, 1, `expected exit 1 on EADDRINUSE, got ${JSON.stringify(r)}\n${r.output}`);
    assert.match(r.output, /uncaught exception/);
    assert.match(r.output, /shutting down/);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

await test("index.js: syntax and exports are intact", async () => {
  requireExpress();
  const r = spawnSync(process.execPath, ["--check", INDEX], { encoding: "utf-8", cwd: SERVER_DIR });
  assert.strictEqual(r.status, 0, r.stderr);
  const src = fs.readFileSync(INDEX, "utf-8");
  assert.match(src, /export \{ app, server \}/, "server should be exported for tests");
  assert.match(src, /SIGTERM/, "SIGTERM handler missing");
  assert.match(src, /SIGINT/, "SIGINT handler missing");
  assert.match(src, /server\.close\(/, "server.close() missing");
});

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail > 0 ? 1 : 0);
