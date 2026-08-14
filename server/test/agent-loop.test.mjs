import assert from "node:assert";
import { runAgentLoop, runSingleAgent } from "../src/agents.js";

let pass = 0;
let fail = 0;
const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
};

const toolCall = (name, args, id) => ({
  id: id || `call_${Math.random().toString(36).slice(2, 8)}`,
  type: "function",
  function: { name, arguments: args },
});

const MOCK_TOOLS = [{ type: "function", function: { name: "calculate", description: "eval", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } } }];

// Mock LLM that replays a scripted sequence of streamed completions.
class MockClient {
  constructor(steps, opts = {}) {
    this.steps = steps;
    this.opts = opts;
    this.calls = 0;
    this.lastMessages = null;
  }
  async completeStream({ messages, tools, temperature, maxTokens, onDelta }) {
    this.lastMessages = messages;
    const n = this.calls++;
    if (this.opts.failFirst && n < this.opts.failFirst) {
      const err = new Error(this.opts.failMsg || "network boom");
      err.status = 0;
      throw err;
    }
    if (this.opts.fail5xx !== undefined && n === this.opts.fail5xx) {
      const err = new Error("server error");
      err.status = 502;
      throw err;
    }
    if (this.opts.fail4xx !== undefined && n === this.opts.fail4xx) {
      const err = new Error("bad request");
      err.status = 400;
      throw err;
    }
    const step = this.steps[Math.min(n, this.steps.length - 1)];
    const resolved = typeof step === "function" ? step({ messages, round: n + 1 }) : step;
    return {
      message: resolved.message,
      finishReason: resolved.finishReason || "stop",
    };
  }
}

const baseMsgs = () => [{ role: "system", content: "test" }, { role: "user", content: "hi" }];

await test("agent loop: runs tools then finishes with content", async () => {
  const steps = [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [toolCall("calculate", '{"expression":"6*7"}')],
      },
      finishReason: "tool_calls",
    },
    { message: { role: "assistant", content: "The answer is 42.", tool_calls: [] }, finishReason: "stop" },
  ];
  const client = new MockClient(steps);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.strictEqual(r.content, "The answer is 42.", `content: ${r.content}`);
  assert.strictEqual(r.toolCalls.length, 1);
  assert.ok(r.toolCalls[0].result.includes("42"), `result: ${r.toolCalls[0].result}`);
  // tool result must have been fed back to the LLM
  const toolMsg = client.lastMessages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.content.includes("42"), "tool result not fed back");
  assert.ok(client.lastMessages.some((m) => m.role === "assistant" && m.tool_calls), "assistant tool_calls message missing");
});

await test("agent loop: multiple tools in one round all execute", async () => {
  const steps = [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          toolCall("calculate", '{"expression":"1+1"}', "call_a"),
          toolCall("calculate", '{"expression":"2+2"}', "call_b"),
        ],
      },
      finishReason: "tool_calls",
    },
    { message: { role: "assistant", content: "done", tool_calls: [] }, finishReason: "stop" },
  ];
  const client = new MockClient(steps);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.strictEqual(r.toolCalls.length, 2);
  assert.ok(r.toolCalls[0].result.includes("2") && r.toolCalls[1].result.includes("4"), JSON.stringify(r.toolCalls));
});

await test("agent loop: unknown tool becomes an error message, loop continues", async () => {
  let rounds = 0;
  const client = new MockClient([
    {
      message: { role: "assistant", content: "", tool_calls: [toolCall("no_such_tool", "{}")] },
      finishReason: "tool_calls",
    },
    ({ messages }) => {
      rounds = messages.filter((m) => m.role === "tool").length;
      return { message: { role: "assistant", content: "recovered", tool_calls: [] }, finishReason: "stop" };
    },
  ]);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.strictEqual(r.toolCalls.length, 1);
  assert.ok(r.toolCalls[0].result.includes("unknown tool"), r.toolCalls[0].result);
  assert.strictEqual(rounds, 1, "loop should continue after tool error");
  assert.strictEqual(r.content, "recovered");
});

await test("agent loop: malformed JSON args repaired (code fence / prose)", async () => {
  const noisy = 'Here you go:\n```json\n{"expression":"20/5"}\n```';
  const client = new MockClient([
    { message: { role: "assistant", content: "", tool_calls: [toolCall("calculate", noisy)] }, finishReason: "tool_calls" },
    { message: { role: "assistant", content: "ok", tool_calls: [] }, finishReason: "stop" },
  ]);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.ok(r.toolCalls[0].result.includes("4"), `repaired args failed: ${r.toolCalls[0].result}`);
});

await test("agent loop: garbage args that cannot be repaired reported, no crash", async () => {
  const client = new MockClient([
    { message: { role: "assistant", content: "", tool_calls: [toolCall("calculate", "not-json-at-all!!!")] }, finishReason: "tool_calls" },
    { message: { role: "assistant", content: "fine", tool_calls: [] }, finishReason: "stop" },
  ]);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.ok(r.toolCalls[0].result.includes("could not parse"), r.toolCalls[0].result);
  assert.strictEqual(r.content, "fine");
});

await test("agent loop: repeated identical tool calls terminate early", async () => {
  const same = toolCall("calculate", '{"expression":"1"}', "loopcall");
  const steps = [];
  for (let i = 0; i < 5; i++) steps.push({ message: { role: "assistant", content: "", tool_calls: [same] }, finishReason: "tool_calls" });
  const client = new MockClient(steps);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100, maxRounds: 10 });
  assert.strictEqual(r.toolCalls.length, 2, `expected 2 executions before loop guard, got ${r.toolCalls.length}`);
  assert.ok(r.content.includes("assuming a loop"), r.content);
  assert.strictEqual(client.calls, 3, `expected 3 LLM rounds (2 exec + guard), got ${client.calls}`);
});

await test("agent loop: network errors are retried then succeed", async () => {
  const client = new MockClient(
    [
      { message: { role: "assistant", content: "recovered after retry", tool_calls: [] }, finishReason: "stop" },
    ],
    { failFirst: 2, failMsg: "ECONNREFUSED" },
  );
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.strictEqual(r.content, "recovered after retry");
  assert.strictEqual(client.calls, 3, "should have taken 2 retries + success");
});

await test("agent loop: 5xx is retried", async () => {
  const client = new MockClient(
    [{ message: { role: "assistant", content: "ok", tool_calls: [] }, finishReason: "stop" }],
    { fail5xx: 0 },
  );
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.strictEqual(r.content, "ok");
  assert.ok(client.calls >= 2, `expected retry, calls=${client.calls}`);
});

await test("agent loop: 4xx is NOT retried and throws on first round", async () => {
  const client = new MockClient(
    [{ message: { role: "assistant", content: "x", tool_calls: [] }, finishReason: "stop" }],
    { fail4xx: 0 },
  );
  await assert.rejects(() => runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 }), /bad request/);
  assert.strictEqual(client.calls, 1, "4xx must not be retried");
});

await test("agent loop: LLM failure after tool rounds appends notice and returns partial", async () => {
  const client = new MockClient([
    { message: { role: "assistant", content: "", tool_calls: [toolCall("calculate", '{"expression":"1+1"}')] }, finishReason: "tool_calls" },
    { message: { role: "assistant", content: "partial", tool_calls: [] }, finishReason: "stop" },
  ]);
  // make the 2nd LLM call throw by failing 4xx on round index 1
  client.opts.fail4xx = 1;
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.ok(r.toolCalls.length === 1, `tool ran: ${r.toolCalls.length}`);
  assert.ok(r.content.includes("Agent stopped"), r.content);
});

await test("agent loop: zero tool calls returns content immediately", async () => {
  const client = new MockClient([{ message: { role: "assistant", content: "plain answer", tool_calls: [] }, finishReason: "stop" }]);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.strictEqual(r.content, "plain answer");
  assert.strictEqual(r.toolCalls.length, 0);
  assert.strictEqual(client.calls, 1);
});

await test("single agent: exposes same hardened behavior", async () => {
  const steps = [
    { message: { role: "assistant", content: "", tool_calls: [toolCall("calculate", '{"expression":"3*3"}')] }, finishReason: "tool_calls" },
    { message: { role: "assistant", content: "nine", tool_calls: [] }, finishReason: "stop" },
  ];
  const client = new MockClient(steps);
  const r = await runSingleAgent({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.ok(r.toolCalls[0].result.includes("9"), r.toolCalls[0].result);
  assert.strictEqual(r.content, "nine");
});

await test("agent loop: long tool result is truncated but tagged", async () => {
  const client = new MockClient([
    { message: { role: "assistant", content: "", tool_calls: [toolCall("run_js", `{"code":"'y'.repeat(9000)"}`)] }, finishReason: "tool_calls" },
    { message: { role: "assistant", content: "done", tool_calls: [] }, finishReason: "stop" },
  ]);
  const r = await runAgentLoop({ client, messages: baseMsgs(), tools: MOCK_TOOLS, maxTokens: 100 });
  assert.ok(r.toolCalls[0].result.includes("(truncated"), r.toolCalls[0].result.slice(0, 120));
  assert.ok(r.toolCalls[0].result.length <= 8000 + 80, `result too long: ${r.toolCalls[0].result.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
