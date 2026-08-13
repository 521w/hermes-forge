import { executeTool } from "./tools.js";

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
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userPrompt },
  ];

  let finalContent = "";
  let toolCallsLog = [];

  for (let round = 0; round < 6; round++) {
    const res = await client.completeStream({
      messages,
      tools,
      temperature,
      maxTokens,
      onDelta: (d) => {
        if (d.text && onDelta) onDelta({ text: d.text });
        if (d.toolCallDelta && onDelta) onDelta({ toolCallDelta: d.toolCallDelta });
      },
    });

    const msg = res.message;
    if (msg.content) finalContent += msg.content;

    const calls = (msg.tool_calls || []).filter((c) => c.function?.name);
    if (!calls.length) break;

    const toolMessages = [{ role: "assistant", content: msg.content || "", tool_calls: calls }];
    for (const call of calls) {
      let result;
      try {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = { _raw: call.function.arguments };
        }
        if (onDelta) onDelta({ toolStart: { name: call.function.name, arguments: call.function.arguments } });
        result = await executeTool(call.function.name, args);
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      if (onDelta) onDelta({ toolResult: { name: call.function.name, result } });
      toolCallsLog.push({ name: call.function.name, arguments: call.function.arguments, result });
      toolMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(result).slice(0, 8000),
      });
    }
    messages.push(...toolMessages);
  }

  return { content: finalContent, toolCalls: toolCallsLog };
}

// Single-agent agentic loop (Hermes native behavior, enhanced with our tools).
export async function runSingleAgent({ client, messages, tools, temperature, maxTokens, onDelta }) {
  let finalContent = "";
  const toolCallsLog = [];

  for (let round = 0; round < 6; round++) {
    const res = await client.completeStream({
      messages,
      tools,
      temperature,
      maxTokens,
      onDelta: (d) => {
        if (d.text && onDelta) onDelta({ text: d.text });
        if (d.toolCallDelta && onDelta) onDelta({ toolCallDelta: d.toolCallDelta });
      },
    });

    const msg = res.message;
    if (msg.content) finalContent += msg.content;

    const calls = (msg.tool_calls || []).filter((c) => c.function?.name);
    if (!calls.length) break;

    const toolMessages = [{ role: "assistant", content: msg.content || "", tool_calls: calls }];
    for (const call of calls) {
      let result;
      try {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = { _raw: call.function.arguments };
        }
        if (onDelta) onDelta({ toolStart: { name: call.function.name, arguments: call.function.arguments } });
        result = await executeTool(call.function.name, args);
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      if (onDelta) onDelta({ toolResult: { name: call.function.name, result } });
      toolCallsLog.push({ name: call.function.name, arguments: call.function.arguments, result });
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(0, 8000) });
    }
    messages.push(...toolMessages);
  }

  return { content: finalContent, toolCalls: toolCallsLog };
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
