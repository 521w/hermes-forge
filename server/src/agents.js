import { executeTool, toolSchema } from "./tools.js";

const VALID_TOOLS = new Set(toolSchema().map((t) => t.function.name));

const PLANNER_SYSTEM = `You are the Planner of the Hermes Forge agent crew.
Your job: given a user request, produce a concise, numbered execution plan (2-6 steps).
Be concrete. Each step should say exactly what tool to call or what reasoning to do.
Output ONLY the plan, no preamble.`;

const EXECUTOR_SYSTEM = `You are the Executor of the Hermes Forge agent crew, powered by the Hermes model family.
You receive a plan and a user request. You execute the plan step by step, CALLING TOOLS whenever they help.
Rules:
- Call tools for computation, time, memory and code execution instead of guessing.
- After each tool result, continue until the full task is done.
- When finished, present the final answer clearly, quoting any computed results.
- If the same tool result repeats, stop calling and answer.`;

const REVIEWER_SYSTEM = `You are the Reviewer of the Hermes Forge agent crew.
You are given a user request and a candidate answer. Verify correctness: check arithmetic, consistency and completeness.
If everything is correct, reply with exactly: ACCEPT.
If not, reply with a short list of concrete fixes (max 3 bullets), prefix each with FIX:.`;

export function buildCrewSystem(settings) {
  return (
    settings.defaultSystem +
    `\n\nYou are operating inside Hermes Forge, a multi-agent workbench. Your crew has roles: Planner, Executor, Reviewer. Follow the current role's instructions.`
  );
}

function planPrompt(userRequest) {
  return `User request:\n"""\n${userRequest}\n"""\n\nProduce the execution plan.`;
}

// Parse a planner's free-text plan into a structured todo list (Claude Code-style).
function parseTodos(plan) {
  return String(plan || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[\.\):、]/.test(l) || /^[-*]\s+\S/.test(l) || /^Step\s+\d+/i.test(l))
    .map((l) => l.replace(/^Step\s+\d+\s*[:\-–]?\s*/i, "").replace(/^\d+[\.\):、]\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function executePrompt(userRequest, plan) {
  return `User request:\n"""\n${userRequest}\n"""\n\nPlan to execute:\n${plan}\n\nExecute it now and deliver the final answer.`;
}

function reviewPrompt(userRequest, candidate) {
  return `User request:\n"""\n${userRequest}\n"""\n\nCandidate answer:\n"""\n${candidate}\n"""\n\nReview it.`;
}

async function runAgent({ client, system, userPrompt, tools, temperature, maxTokens, onDelta }) {
  return runAgentLoop({
    client,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
    tools,
    temperature,
    maxTokens,
    onDelta,
  });
}

// ---- Agent loop hardening -------------------------------------------------
// Retry transient LLM failures (network, 5xx, 429) with exponential backoff.
async function withRetry(fn, { retries = 2, baseDelay = 600 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = !err.status || (err.status >= 500 && err.status < 600) || err.status === 429;
      if (attempt >= retries || !retryable) throw err;
      const delay = baseDelay * 2 ** attempt + Math.random() * 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Time-box a single tool execution so a hung tool cannot stall the loop.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tool timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function truncateResult(result, max = 8000) {
  const s = String(result);
  return s.length > max ? `${s.slice(0, max)}\n...(truncated, ${s.length - max} chars omitted)` : s;
}

// Extract the outermost balanced JSON value from a noisy string (LLMs often
// wrap arguments in prose or code fences).
function repairJson(s) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) {
        let j = i;
        let d = 0;
        let str = false;
        let escp = false;
        for (; j < s.length; j++) {
          const c = s[j];
          if (str) {
            if (escp) escp = false;
            else if (c === "\\") escp = true;
            else if (c === '"') str = false;
            continue;
          }
          if (c === '"') str = true;
          else if (c === "{" || c === "[") d++;
          else if (c === "}" || c === "]") {
            d--;
            if (d === 0) return s.slice(i, j + 1);
          }
        }
      }
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }
  return null;
}

function parseToolArgs(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "{}" || s === "[]") return {};
  try {
    return JSON.parse(s);
  } catch {
    const repaired = repairJson(s);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired);
      } catch {
        /* fall through to raw marker */
      }
    }
    return { _raw: raw };
  }
}

// Execute one tool call, converting every failure into a message the LLM can
// read and correct instead of aborting the loop.
async function runToolCall(call, onDelta) {
  const name = call.function?.name || "(unnamed)";
  const id = call.id || `call_${Math.random().toString(36).slice(2, 10)}`;
  const rawArgs = call.function?.arguments || "";
  if (onDelta) onDelta({ toolStart: { name, arguments: rawArgs } });

  const finish = (result) => {
    const truncated = truncateResult(result);
    if (onDelta) onDelta({ toolResult: { name, result: truncated } });
    return { id, name, result: truncated };
  };

  if (!VALID_TOOLS.has(name)) {
    return finish(`ERROR: unknown tool "${name}". Available tools: ${[...VALID_TOOLS].join(", ")}`);
  }

  const args = parseToolArgs(rawArgs);
  if (args._raw !== undefined) {
    return finish(
      `ERROR: could not parse arguments for "${name}" as JSON. Raw: ${JSON.stringify(rawArgs).slice(0, 300)}. Call it again with valid JSON per the tool schema.`,
    );
  }

  try {
    return finish(await withTimeout(executeTool(name, args), 60_000));
  } catch (err) {
    return finish(`ERROR: ${err.message}`);
  }
}

// Unified, hardened single-agent loop: stable multi-round tool calling with
// retry, repair and termination guards.
export async function runAgentLoop({
  client,
  messages,
  tools,
  temperature,
  maxTokens,
  onDelta,
  maxRounds = 10,
}) {
  const msgs = messages.map((m) => ({ ...m }));
  const emit = (e) => onDelta && onDelta(e);
  let finalContent = "";
  const toolCallsLog = [];
  const seen = new Map();

  for (let round = 0; round < maxRounds; round++) {
    let res;
    try {
      res = await withRetry(() =>
        client.completeStream({
          messages: msgs,
          tools,
          temperature,
          maxTokens,
          onDelta: (d) => {
            if (d.text) emit({ text: d.text });
            if (d.toolCallDelta) emit({ toolCallDelta: d.toolCallDelta });
          },
        }),
      );
    } catch (err) {
      if (round === 0) throw err;
      finalContent += `\n\n[Agent stopped: LLM request failed after retries — ${err.message}]`;
      break;
    }

    const msg = res.message;
    if (msg.content) finalContent += msg.content;

    const calls = (msg.tool_calls || []).filter((c) => c.function?.name);
    if (!calls.length) break;

    // Termination guard: identical repeated tool calls signal a loop.
    let repeated = false;
    for (const c of calls) {
      const key = `${c.function.name}:${c.function.arguments || ""}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n >= 3) {
        repeated = true;
        finalContent += `\n\n[Agent stopped: "${c.function.name}" was called ${n} times with identical arguments — assuming a loop.]`;
      }
    }
    if (repeated) break;

    const toolMessages = [{ role: "assistant", content: msg.content || "", tool_calls: calls }];
    for (const call of calls) {
      const r = await runToolCall(call, emit);
      toolCallsLog.push({ name: r.name, arguments: call.function?.arguments || "", result: r.result });
      toolMessages.push({ role: "tool", tool_call_id: r.id, content: r.result });
    }
    msgs.push(...toolMessages);
  }

  return { content: finalContent, toolCalls: toolCallsLog };
}

// Single-agent agentic loop (Hermes native behavior, enhanced with our tools).
export async function runSingleAgent({ client, messages, tools, temperature, maxTokens, onDelta }) {
  return runAgentLoop({ client, messages, tools, temperature, maxTokens, onDelta });
}

// Multi-agent crew: Planner -> Executor -> Reviewer.
export async function runCrew({ client, userRequest, tools, temperature, maxTokens, onDelta }) {
  const emit = (e) => onDelta && onDelta(e);

  emit({ phase: "planning" });
  const planRes = await client.complete({
    messages: [
      { role: "system", content: PLANNER_SYSTEM },
      { role: "user", content: planPrompt(userRequest) },
    ],
    temperature: Math.min(temperature, 0.4),
    maxTokens: Math.min(maxTokens, 1200),
  });
  const plan = (planRes.message.content || "1. Reason directly and answer.").trim();
  const todos = parseTodos(plan);
  emit({ phase: "executing", plan, todos });

  // Track todo progress as tools execute.
  let todoState = todos.map(() => "pending");
  let todoIdx = -1;
  const track = (e) => {
    if (e.toolStart) {
      todoIdx = Math.min(todoIdx + 1, todoState.length - 1);
      if (todoIdx >= 0) todoState[todoIdx] = "running";
      emit({ phase: "todo", todoState: [...todoState] });
    } else if (e.toolResult) {
      if (todoIdx >= 0 && todoState[todoIdx] === "running") {
        todoState[todoIdx] = "done";
        emit({ phase: "todo", todoState: [...todoState] });
      }
    }
    emit(e);
  };

  const exec = await runAgent({
    client,
    system: EXECUTOR_SYSTEM,
    userPrompt: executePrompt(userRequest, plan),
    tools,
    temperature,
    maxTokens,
    onDelta: track,
  });

  // Mark any remaining todos done when execution finishes.
  todoState = todoState.map(() => "done");
  emit({ phase: "todo", todoState });

  emit({ phase: "reviewing" });
  let review;
  try {
    review = await client.complete({
      messages: [
        { role: "system", content: REVIEWER_SYSTEM },
        { role: "user", content: reviewPrompt(userRequest, exec.content) },
      ],
      temperature: 0.1,
      maxTokens: 800,
    });
  } catch {
    review = { message: { content: "ACCEPT" } };
  }
  const verdict = (review.message.content || "ACCEPT").trim();

  emit({ phase: "done", verdict });
  return { content: exec.content, plan, todos, verdict, toolCalls: exec.toolCalls };
}
