// Regression tests for streaming tool-call accumulation.
//
// The bug being locked down: `applyToolDelta` used to have a dead replacement
// branch, so a provider that resends the full arguments buffer on every chunk
// produced corrupted JSON (`{"exp{"expression":…`), and a provider that repeats
// the tool name produced `calculatecalculate`. Both made every tool call fail
// with "invalid arguments" against such providers.
import assert from "node:assert";
import { HermesClient, applyToolDelta } from "../src/llm.js";
import { server as mockServer } from "../mocks/mock-llm.mjs";

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

const frag = (args, name) => ({
  index: 0,
  ...(name ? { function: { name } } : {}),
  ...(args !== undefined ? { function: { ...(name ? { name } : {}), arguments: args } } : {}),
});

await test("applyToolDelta: appended fragments accumulate", async () => {
  const acc = [];
  applyToolDelta(acc, frag('{"exp'));
  applyToolDelta(acc, frag('ression":'));
  applyToolDelta(acc, frag('"6 * 7"}'));
  assert.strictEqual(acc[0].function.arguments, '{"expression":"6 * 7"}');
  assert.deepStrictEqual(JSON.parse(acc[0].function.arguments), { expression: "6 * 7" });
});

await test("applyToolDelta: full-buffer resend replaces instead of appending", async () => {
  const acc = [];
  applyToolDelta(acc, frag('{"exp'));
  applyToolDelta(acc, frag('{"expression":'));
  applyToolDelta(acc, frag('{"expression":"6 * 7"}'));
  assert.strictEqual(acc[0].function.arguments, '{"expression":"6 * 7"}');
});

await test("applyToolDelta: name resend does not duplicate", async () => {
  const acc = [];
  applyToolDelta(acc, { index: 0, function: { name: "cal" } });
  applyToolDelta(acc, { index: 0, function: { name: "calculate" } });
  assert.strictEqual(acc[0].function.name, "calculate");
});

await test("applyToolDelta: name split mid-identifier still accumulates", async () => {
  const acc = [];
  applyToolDelta(acc, { index: 0, function: { name: "cal" } });
  applyToolDelta(acc, { index: 0, function: { name: "culate" } });
  assert.strictEqual(acc[0].function.name, "calculate");
});

await test("applyToolDelta: distinct indices stay separate", async () => {
  const acc = [];
  applyToolDelta(acc, { index: 0, id: "a", function: { name: "calculate", arguments: "{}" } });
  applyToolDelta(acc, { index: 1, id: "b", function: { name: "fibonacci", arguments: "{}" } });
  assert.strictEqual(acc.length, 2);
  assert.strictEqual(acc[0].function.name, "calculate");
  assert.strictEqual(acc[1].function.name, "fibonacci");
});

// End-to-end: drive the real SSE parser against the mock, whose first round
// deliberately splits the name ("cal" + "culate") and the arguments buffer.
await test("completeStream: parses a chunked SSE tool call end to end", async () => {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const port = mockServer.address().port;
  try {
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${port}`, model: "mock" });
    const res = await client.completeStream({
      messages: [{ role: "user", content: "what is 6 * 7" }],
      tools: [{ type: "function", function: { name: "calculate", parameters: { type: "object" } } }],
    });
    assert.strictEqual(res.message.tool_calls.length, 1);
    assert.strictEqual(res.message.tool_calls[0].function.name, "calculate");
    assert.deepStrictEqual(JSON.parse(res.message.tool_calls[0].function.arguments), { expression: "6 * 7" });
    assert.strictEqual(res.finishReason, "tool_calls");
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

await test("completeStream: second round returns text content", async () => {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const port = mockServer.address().port;
  try {
    const client = new HermesClient({ baseUrl: `http://127.0.0.1:${port}`, model: "mock" });
    const res = await client.completeStream({
      messages: [
        { role: "user", content: "what is 6 * 7" },
        { role: "tool", content: "42" },
      ],
    });
    assert.match(res.message.content, /42/);
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
