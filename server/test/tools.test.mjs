import assert from "node:assert";
import { executeTool, toolSchema, SKILLS } from "../src/tools.js";

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

await test("calculate: basic arithmetic", async () => {
  assert.strictEqual(await executeTool("calculate", { expression: "6 * 7" }), "42");
});

await test("calculate: complex expression", async () => {
  const r = await executeTool("calculate", { expression: "(3 * 7 + 1) ** 2 / Math.sqrt(16)" });
  assert.strictEqual(r, "121");
});

await test("calculate: invalid input throws", async () => {
  await assert.rejects(() => executeTool("calculate", { expression: "process.exit(1)" }));
});

await test("calculate: object output", async () => {
  const r = await executeTool("calculate", { expression: "JSON.stringify({a:1,b:[1,2]})" });
  assert.deepStrictEqual(JSON.parse(r), { a: 1, b: [1, 2] });
});

await test("get_current_time: default", async () => {
  const r = await executeTool("get_current_time", {});
  assert.ok(typeof r === "string" && r.length > 5);
});

await test("get_current_time: invalid tz falls back", async () => {
  const r = await executeTool("get_current_time", { timezone: "Not/AZone" });
  assert.ok(typeof r === "string" && r.length > 5);
});

await test("run_js: basic code", async () => {
  const r = await executeTool("run_js", { code: "console.log(1 + 1)" });
  assert.strictEqual(r, "2");
});

await test("run_js: cannot escape sandbox", async () => {
  const r = await executeTool("run_js", { code: "console.log(typeof process)" });
  assert.ok(r.includes("undefined") || r.includes("error"), `got: ${r}`);
});

await test("run_js: infinite loop is killed", async () => {
  await assert.rejects(() => executeTool("run_js", { code: "while(true){}" }), /timed out/i);
});

await test("memory: store then recall", async () => {
  const key = `ut_${Date.now()}`;
  await executeTool("memory_store", { key, value: "test fact 123" });
  const recalled = JSON.parse(await executeTool("memory_recall", { key }));
  assert.strictEqual(recalled[0].value, "test fact 123");
});

await test("memory: recall missing key", async () => {
  const r = await executeTool("memory_recall", { key: "does_not_exist_xyz" });
  assert.ok(r.includes("No memory found"), `got: ${r}`);
});

await test("memory: recall all", async () => {
  const r = await executeTool("memory_recall", { key: "*" });
  assert.ok(typeof r === "string");
});

await test("fibonacci: small n", async () => {
  assert.strictEqual(await executeTool("fibonacci", { n: 10 }), "55");
});

await test("fibonacci: large n", async () => {
  const r = await executeTool("fibonacci", { n: 1000 });
  assert.strictEqual(r.length, 209);
});

await test("fibonacci: rejects too-large n", async () => {
  const r = await executeTool("fibonacci", { n: 9999999 });
  assert.ok(r.includes("too large"), `got: ${r}`);
});

await test("read_file: reads workspace file", async () => {
  const r = await executeTool("read_file", { path: "README.md" });
  assert.ok(r.startsWith("# Hermes Forge"), `got: ${r.slice(0, 40)}`);
});

await test("read_file: blocks path traversal", async () => {
  await assert.rejects(() => executeTool("read_file", { path: "../../etc/passwd" }), /outside workspace/i);
});

await test("read_file: missing file throws", async () => {
  await assert.rejects(() => executeTool("read_file", { path: "no/such/file.txt" }), /not found/i);
});

await test("list_dir: lists root", async () => {
  const r = await executeTool("list_dir", {});
  assert.ok(r.includes("server") && r.includes("web"), `got: ${r.slice(0, 80)}`);
});

await test("grep_files: finds pattern", async () => {
  const r = await executeTool("grep_files", { pattern: "Planner", include: "*.js" });
  assert.ok(r.includes("agents.js"), `got: ${r.slice(0, 80)}`);
});

await test("write_file: writes then reads back", async () => {
  const p = `tmp_tooltest_${Date.now()}.txt`;
  const w = await executeTool("write_file", { path: p, content: "hello world" });
  assert.ok(w.includes("Wrote"), w);
  const r = await executeTool("read_file", { path: p });
  assert.strictEqual(r, "hello world");
});

await test("memory: full-text search finds fact", async () => {
  const key = `ut_search_${Date.now()}`;
  const uniq = `matcha_latte_${key}`;
  await executeTool("memory_store", { key, value: `The user enjoys drinking ${uniq} on Sundays` });
  const r = JSON.parse(await executeTool("memory_search", { query: uniq, limit: 20 }));
  assert.ok(r.some((e) => e.key === key), `got: ${JSON.stringify(r).slice(0, 80)}`);
});

await test("memory: search no match", async () => {
  const r = await executeTool("memory_search", { query: "zzzzzqqqqq nonexistent" });
  assert.ok(r.includes("No memory matches"), `got: ${r}`);
});

await test("web_fetch: rejects non-http", async () => {
  await assert.rejects(() => executeTool("web_fetch", { url: "file:///etc/passwd" }), /http/);
});

await test("toolSchema: defines all 12 tools + 5 skills", async () => {
  const names = toolSchema().map((t) => t.function.name);
  const expected = [
    "calculate", "fibonacci", "get_current_time", "memory_recall", "memory_store", "run_js",
    "read_file", "write_file", "list_dir", "grep_files", "web_fetch", "memory_search",
  ];
  for (const n of expected) assert.ok(names.includes(n), `missing ${n}`);
  const skills = names.filter((n) => n.startsWith("skill_"));
  assert.deepStrictEqual(skills.sort(), [
    "skill_github", "skill_pest_identification", "skill_plant_disease",
    "skill_telegram", "skill_web_search",
  ]);
});

await test("skills: dynamic discovery finds 5 skills", async () => {
  assert.strictEqual(SKILLS.length, 5);
  assert.deepStrictEqual(SKILLS.map((s) => s.name).sort(), [
    "github", "pest-identification", "plant-disease", "telegram", "web-search",
  ]);
  for (const s of SKILLS) assert.ok(s.description.length > 0 && s.instructions.length > 0, `${s.name} meta missing`);
});

await test("skills: plant-disease matches symptoms", async () => {
  const r = JSON.parse(await executeTool("skill_plant_disease", { input: "tomato leaves brown circular spots yellow halo" }));
  assert.ok(Array.isArray(r.diagnosis) && r.diagnosis.length >= 1);
  assert.ok(r.diagnosis[0].disease.includes("Late Blight"), `got: ${r.diagnosis[0].disease}`);
});

await test("skills: pest-identification matches description", async () => {
  const r = JSON.parse(await executeTool("skill_pest_identification", { input: "tiny white flies fly up when I touch the plant" }));
  assert.ok(Array.isArray(r.pests) && r.pests.length >= 1);
  assert.ok(r.pests[0].pest.includes("Whiteflies"), `got: ${r.pests[0].pest}`);
});

await test("skills: telegram reports missing config gracefully", async () => {
  const r = JSON.parse(await executeTool("skill_telegram", { input: "send: hello" }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.fix.includes("TELEGRAM_BOT_TOKEN"), `got: ${JSON.stringify(r).slice(0, 80)}`);
});

await test("skills: unknown skill throws", async () => {
  await assert.rejects(() => executeTool("skill_nope", { input: "x" }), /Unknown skill/);
});

await test("unknown tool throws", async () => {
  await assert.rejects(() => executeTool("nope", {}), /Unknown tool/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
