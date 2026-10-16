// Regression tests for the JS sandbox used by `calculate` / `run_js`.
//
// Three defects are locked down here:
//   1. Sandbox escape: `this.constructor.constructor("return process")()` ran
//      arbitrary host code, because the sandbox inherited Object.prototype and
//      code generation from strings was enabled.
//   2. Dynamic import: `import("node:fs")` inside the vm made Node throw
//      ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING asynchronously and killed the
//      whole server process.
//   3. Unhandled rejection: `Promise.reject(new Error(..))` inside the vm also
//      killed the whole process by default. The guard must contain it while
//      leaving host rejections fatal.
//
// The escape/import cases can be asserted in-process because they throw
// synchronously. The crash cases cannot: if the guard regresses, the test file
// itself dies, so they run in a child process and are judged by exit code.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeTool } from "../src/tools.js";

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, "..");

// Runs one `run_js` snippet in a fresh node process and reports how it ended.
function runIsolated(code) {
  const script = `
import { executeTool } from ${JSON.stringify(path.join(SERVER_DIR, "src/tools.js"))};
try {
  const out = await executeTool("run_js", { code: ${JSON.stringify(code)} });
  console.log("RESULT " + String(out).replace(/\\n/g, " | "));
} catch (err) {
  console.log("THREW " + err.message);
}
`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
    timeout: 30_000,
    cwd: SERVER_DIR,
  });
  return { exit: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// --- defect 1: escape vectors -------------------------------------------------

const ESCAPES = [
  [`this.constructor.constructor("return process")().version`, "this.constructor"],
  [`Object.constructor("return typeof process")()`, "Object.constructor"],
  [`console.log.constructor("return typeof process")()`, "console.log.constructor"],
  [`Object.getPrototypeOf(console.log).constructor("return typeof process")()`, "getPrototypeOf(console.log).constructor"],
  [`[].constructor.constructor("return typeof process")()`, "[].constructor.constructor"],
  [`(0, eval)("1 + 1")`, "indirect eval"],
  [`new Function("return typeof process")()`, "new Function"],
];

for (const [vector, label] of ESCAPES) {
  await test(`sandbox: escape blocked (${label})`, async () => {
    await assert.rejects(
      () => executeTool("run_js", { code: vector }),
      (err) => {
        // Either the vm refuses to generate code from strings, or the lookup
        // itself fails; both are safe. What must never happen is a value.
        assert.ok(
          /code generation from strings disallowed|is not a function|Cannot read|undefined/i.test(err.message),
          `unexpected failure mode: ${err.message}`,
        );
        return true;
      },
    );
  });
}

await test("sandbox: learning the host version is impossible", async () => {
  const r = await executeTool("run_js", { code: `console.log(typeof process, typeof require, typeof globalThis.process)` });
  assert.ok(!r.includes("v24"), `leaked host version: ${r}`);
  assert.ok(!r.includes("object object"), `leaked a host global: ${r}`);
});

// --- defect 2: dynamic import -------------------------------------------------

await test("sandbox: dynamic import is rejected with a clear error", async () => {
  await assert.rejects(
    () => executeTool("run_js", { code: `const fs = await import("node:fs"); console.log("pwned")` }),
    /dynamic import is not allowed/i,
  );
});

await test("sandbox: import-looking string literals are not false positives", async () => {
  const r = await executeTool("run_js", { code: `console.log("call import(x) later".length > 0 ? "ok" : "no")` });
  assert.match(r, /ok/);
});

await test("sandbox: import-shaped text inside a comment is not a false positive", async () => {
  const r = await executeTool("run_js", { code: `// import("node:fs")\nconsole.log(1 + 1)` });
  assert.match(r, /2/);
});

for (const [code, label] of [
  [`Promise.reject(new Error("boom"))`, "Promise.reject(Error)"],
  [`Promise.reject(1)`, "Promise.reject(non-Error)"],
  [`void (async () => { throw new Error("async-boom") })()`, "async IIFE throw"],
  [`Promise.resolve().then(() => { throw new Error("then-boom") })`, "then() throw"],
]) {
  await test(`sandbox: ${label} does not kill the host process`, async () => {
    const r = runIsolated(code);
    assert.strictEqual(r.exit, 0, `child exited ${r.exit}\nstdout: ${r.stdout}\nstderr: ${r.stderr.slice(0, 400)}`);
    assert.match(r.stdout, /Unhandled rejection/, `rejection was silently lost: ${r.stdout}`);
  });
}

await test("sandbox: the server process survives a rejection burst", async () => {
  const r = runIsolated(`for (let i = 0; i < 5; i++) Promise.reject(new Error("burst-" + i));`);
  assert.strictEqual(r.exit, 0, `child exited ${r.exit}\nstderr: ${r.stderr.slice(0, 400)}`);
});

// --- behaviour that must keep working ---------------------------------------

await test("sandbox: infinite loop still times out", async () => {
  await assert.rejects(() => executeTool("run_js", { code: `while(true){}` }), /timed out/i);
});

await test("sandbox: normal JavaScript still works", async () => {
  assert.strictEqual(await executeTool("calculate", { expression: "(3 * 7 + 1) ** 2 / Math.sqrt(16)" }), "121");
  assert.strictEqual(await executeTool("run_js", { code: `console.log([1,2,3].map(x => x * x).join(","))` }), "1,4,9");
  assert.strictEqual(await executeTool("run_js", { code: `console.log(JSON.stringify({ a: 1 }))` }), '{"a":1}');
  assert.strictEqual(await executeTool("run_js", { code: `console.log(new Date(0).toISOString())` }), "1970-01-01T00:00:00.000Z");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
