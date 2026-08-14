import { CapacitorHttp } from "@capacitor/core";
import { isNative } from "./env";
import type { ToolCallMeta } from "./types";

// Skills are plain JS, executed inside the local client (web + native).
// @ts-expect-error -- skill modules are untyped plain JS
import skillWebSearch from "../../skills/web-search/index.js";
// @ts-expect-error -- skill modules are untyped plain JS
import skillPlantDisease from "../../skills/plant-disease/index.js";
// @ts-expect-error -- skill modules are untyped plain JS
import skillPestIdentification from "../../skills/pest-identification/index.js";
// @ts-expect-error -- skill modules are untyped plain JS
import skillGithub from "../../skills/github/index.js";
// @ts-expect-error -- skill modules are untyped plain JS
import skillTelegram from "../../skills/telegram/index.js";

export interface LocalSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const STORE_KEY = "hf_settings";
const MEM_KEY = "hf_memory";

export function loadLocalSettings(): LocalSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return defaultSettings();
}

function defaultSettings(): LocalSettings {
  return {
    baseUrl: "http://192.168.1.100:8787/v1",
    apiKey: "",
    model: "hermes",
    temperature: 0.7,
    maxTokens: 4096,
  };
}

export function saveLocalSettings(patch: Partial<LocalSettings>) {
  const next = { ...loadLocalSettings(), ...patch };
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
  return next;
}

// ---- Tools (runs locally inside the app) ----
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const LOCAL_TOOLS: ToolDef[] = [
  {
    name: "calculate",
    description: "Evaluate a math expression (supports + - * / ** % parentheses and Math.* functions). Returns a number.",
    parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  },
  {
    name: "get_current_time",
    description: "Get the current date and time in a given timezone (IANA name).",
    parameters: { type: "object", properties: { timezone: { type: "string" } } },
  },
  {
    name: "run_js",
    description: "Execute a small sandboxed JavaScript snippet. console.log(...) returns the output.",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "memory_store",
    description: "Store a fact or note into long-term memory keyed by topic. Recall later across sessions.",
    parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
  },
  {
    name: "memory_recall",
    description: "Recall all long-term memory entries for a topic key. Use '*' to recall all.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "fibonacci",
    description: "Compute the nth Fibonacci number (optimized, handles large n up to 1e6).",
    parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  },
  {
    name: "currency_convert",
    description: "Convert an amount between currencies at the current approximate rate.",
    parameters: { type: "object", properties: { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["amount", "from", "to"] },
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace. Only available on the server/web edition.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "list_dir",
    description: "List files in a workspace directory. Only available on the server/web edition.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "grep_files",
    description: "Search file contents with a regex in the workspace. Only available on the server/web edition.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, include: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "web_fetch",
    description: "Fetch a web page and return its readable text. Useful for docs, APIs or public info.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "memory_search",
    description: "Full-text search across all long-term memory entries. Returns the most relevant stored facts.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
  },
  {
    name: "skill_web_search",
    description: "Skill: Search the web for a query and return ranked results with titles, URLs and snippets.",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  },
  {
    name: "skill_plant_disease",
    description: "Skill: Diagnose common plant diseases from symptom descriptions and return prevention/treatment advice.",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  },
  {
    name: "skill_pest_identification",
    description: "Skill: Identify common garden and crop pests from descriptions and return control advice.",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  },
  {
    name: "skill_github",
    description: "Skill: Interact with the public GitHub API - search repos/users/code, fetch repo metadata and READMEs.",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  },
  {
    name: "skill_telegram",
    description: "Skill: Send messages and files through the Telegram Bot API (requires TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).",
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  },
];

function safeEval(expression: string): string {
  const sandbox: Record<string, unknown> = {
    Math, JSON, Date, Number, String, Boolean, Array, Object,
    parseInt, parseFloat, isNaN, isFinite, Infinity,
  };
  const fn = new Function(...Object.keys(sandbox), `"use strict"; return (${expression.slice(0, 2000)});`);
  const result = fn(...Object.values(sandbox));
  if (typeof result === "object" && result !== null) return JSON.stringify(result, null, 2);
  return String(result);
}

function fibonacci(n: number): string {
  n = Math.max(0, Math.floor(n || 0));
  if (n > 1000000) return "n too large, max 1000000";
  let a = 0n;
  let b = 1n;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  const out = a.toString();
  return out.length > 500 ? `${out.slice(0, 500)}... (${out.length} digits total)` : out;
}

function getCurrentTime(timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone || undefined, dateStyle: "full", timeStyle: "long" }).format(new Date());
  } catch {
    return new Date().toString();
  }
}

const FX_RATES: Record<string, number> = { USD: 1, CNY: 7.24, EUR: 0.92, JPY: 149.5, GBP: 0.79, HKD: 7.81, KRW: 1350 };

function currencyConvert(amount: number, from: string, to: string): string {
  const f = String(from).toUpperCase();
  const t = String(to).toUpperCase();
  if (!(f in FX_RATES) || !(t in FX_RATES)) return `Unsupported currency. Supported: ${Object.keys(FX_RATES).join(", ")}`;
  const result = (Number(amount) / FX_RATES[f]) * FX_RATES[t];
  return `${amount} ${f} = ${result.toFixed(2)} ${t}`;
}

function memoryAll(): Record<string, unknown[]> {
  try {
    return JSON.parse(localStorage.getItem(MEM_KEY) || "{}");
  } catch {
    return {};
  }
}

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function parseTodos(plan: string): string[] {
  return String(plan || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+[\.\):、]/.test(l) || /^[-*]\s+\S/.test(l) || /^Step\s+\d+/i.test(l))
    .map((l) => l.replace(/^Step\s+\d+\s*[:\-–]?\s*/i, "").replace(/^\d+[\.\):、]\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

async function localExecuteTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "calculate":
      return safeEval(String(args.expression));
    case "get_current_time":
      return getCurrentTime(args.timezone as string | undefined);
    case "run_js": {
      const logs: string[] = [];
      const sandbox: Record<string, unknown> = {
        console: { log: (...a: unknown[]) => { logs.push(a.map(String).join(" ")); return ""; } },
        Math, JSON, Date, Number, String, Array, Object, parseInt, parseFloat,
      };
      const keys = Object.keys(sandbox);
      const fn = new Function(...keys, `"use strict"; ${String(args.code).slice(0, 2000)}`);
      const ret = fn(...Object.values(sandbox));
      if (logs.length) return logs.join("\n");
      return ret === undefined ? "(no output)" : (typeof ret === "object" ? JSON.stringify(ret, null, 2) : String(ret));
    }
    case "memory_store": {
      const key = String(args.key || "default");
      const all = memoryAll();
      all[key] = all[key] || [];
      all[key].push({ value: String(args.value), at: new Date().toISOString() });
      localStorage.setItem(MEM_KEY, JSON.stringify(all));
      return `Stored under key "${key}". Now ${all[key].length} entries.`;
    }
    case "memory_recall": {
      const all = memoryAll();
      if (args.key === "*") return JSON.stringify(all);
      const entries = all[String(args.key)];
      return entries ? JSON.stringify(entries) : `No memory found under key "${args.key}".`;
    }
    case "memory_search": {
      const all = memoryAll();
      const qTokens = tokenize(String(args.query || ""));
      if (!qTokens.length) return "Query too short.";
      const hits: { key: string; value: string; at?: string; score: number }[] = [];
      for (const [key, entries] of Object.entries(all)) {
        for (const entry of entries as { value?: string; at?: string }[]) {
          const text = String(entry.value || "");
          const docTokens = new Set(tokenize(text));
          let score = 0;
          for (const t of qTokens) if (docTokens.has(t)) score += 1;
          const keyTokens = tokenize(key);
          for (const t of qTokens) if (keyTokens.includes(t)) score += 1.5;
          if (score > 0) hits.push({ key, value: text, at: entry.at, score });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, Math.min(Number(args.limit) || 5, 10));
      return top.length ? JSON.stringify(top, null, 2) : "No memory matches that query.";
    }
    case "web_fetch": {
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) return "URL must start with http(s)://";
      try {
        if (isNative()) {
          const res = await CapacitorHttp.get({ url, headers: { "User-Agent": "HermesForge/1.0" } });
          const data = String(res.data ?? "");
          return data.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
        }
        const res = await fetch(url);
        if (!res.ok) return `HTTP ${res.status} from ${url}`;
        const text = await res.text();
        return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
      } catch (err) {
        return `Web fetch failed: ${(err as Error).message}`;
      }
    }
    case "read_file":
    case "list_dir":
    case "grep_files":
      return "This tool is only available on the server/web edition (the local app has no workspace filesystem).";
    case "skill_web_search":
      return String(await skillWebSearch(args.input));
    case "skill_plant_disease":
      return String(await skillPlantDisease(args.input));
    case "skill_pest_identification":
      return String(await skillPestIdentification(args.input));
    case "skill_github":
      return String(await skillGithub(args.input));
    case "skill_telegram":
      return String(await skillTelegram(args.input));
    case "fibonacci":
      return fibonacci(Number(args.n));
    case "currency_convert":
      return currencyConvert(Number(args.amount), String(args.from), String(args.to));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toolSchema(): Record<string, unknown>[] {
  return LOCAL_TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ---- HTTP (native stack bypasses CORS; fetch otherwise) ----
export interface ChatStreamEvent {
  kind: "delta" | "tool_start" | "tool_result" | "phase" | "done" | "error";
  data: unknown;
}

async function httpJson(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; data: unknown }> {
  if (isNative()) {
    const res = await CapacitorHttp.post({ url, method: "POST", headers, data: body });
    return { status: res.status, data: res.data };
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, data: parsed };
}

interface LLMMessage {
  role: string;
  content: string;
  tool_calls?: unknown;
}

async function chatComplete(
  settings: LocalSettings,
  messages: LLMMessage[],
  tools: Record<string, unknown>[],
): Promise<{ content: string; toolCalls: { id: string; function: { name: string; arguments: string } }[] }> {
  const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

  const res = await httpJson(
    url,
    { model: settings.model, messages, tools, temperature: settings.temperature, max_tokens: settings.maxTokens, stream: false },
    headers,
  );

  if (res.status < 200 || res.status >= 300) {
    const msg = (res.data as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    (err as unknown as { status?: number }).status = res.status;
    throw err;
  }

  const choice = (res.data as { choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] })?.choices?.[0];
  return {
    content: choice?.message?.content || "",
    toolCalls: (choice?.message?.tool_calls || []).filter((c) => c.function?.name),
  };
}

const retryable = (err: unknown) => {
  const status = (err as { status?: number }).status;
  return !status || (status >= 500 && status < 600) || status === 429;
};

async function chatWithRetry(settings: LocalSettings, messages: LLMMessage[]): Promise<{
  content: string;
  toolCalls: { id: string; function: { name: string; arguments: string } }[];
}> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      if (!retryable(lastErr)) break;
      await new Promise((r) => setTimeout(r, 600 * 2 ** (attempt - 1) + Math.random() * 200));
    }
    try {
      return await chatComplete(settings, messages, toolSchema());
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function executeTurn(
  settings: LocalSettings,
  messages: LLMMessage[],
  onEvent: (e: ChatStreamEvent) => void,
): Promise<{ content: string; toolCalls: ToolCallMeta[] }> {
  const toolCalls: ToolCallMeta[] = [];
  let finalContent = "";
  const seen = new Map<string, number>();
  const maxRounds = 10;

  for (let round = 0; round < maxRounds; round++) {
    let res: { content: string; toolCalls: { id: string; function: { name: string; arguments: string } }[] };
    try {
      res = await chatWithRetry(settings, messages);
    } catch (err) {
      if (round === 0) throw err;
      finalContent += `\n\n[Agent stopped: LLM request failed — ${(err as Error).message}]`;
      break;
    }

    if (res.content) {
      finalContent += res.content;
      onEvent({ kind: "delta", data: { text: res.content } });
    }
    if (!res.toolCalls.length) break;

    // Termination guard: identical repeated tool calls signal a loop.
    let repeated = false;
    for (const c of res.toolCalls) {
      const key = `${c.function.name}:${c.function.arguments || ""}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n >= 3) {
        repeated = true;
        finalContent += `\n\n[Agent stopped: "${c.function.name}" was called ${n} times with identical arguments — assuming a loop.]`;
      }
    }
    if (repeated) break;

    messages.push({ role: "assistant", content: res.content || "", tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      onEvent({ kind: "tool_start", data: { name, arguments: call.function.arguments } });
      let result: string;
      if (!LOCAL_TOOLS.some((t) => t.name === name)) {
        result = `ERROR: unknown tool "${name}". Available tools: ${LOCAL_TOOLS.map((t) => t.name).join(", ")}`;
      } else if (args._raw !== undefined) {
        result = `ERROR: could not parse arguments for "${name}" as JSON. Raw: ${JSON.stringify(call.function.arguments).slice(0, 300)}. Call it again with valid JSON.`;
      } else {
        try {
          result = String(await localExecuteTool(name, args));
        } catch (err) {
          result = `ERROR: ${(err as Error).message}`;
        }
      }
      if (result.length > 8000) result = `${result.slice(0, 8000)}\n...(truncated, ${result.length - 8000} chars omitted)`;
      onEvent({ kind: "tool_result", data: { name, result } });
      toolCalls.push({ name, arguments: call.function.arguments, result, status: "done" });
      messages.push({ role: "tool", content: result, tool_call_id: call.id } as unknown as LLMMessage);
    }
  }

  return { content: finalContent, toolCalls };
}

// Extract the outermost balanced JSON value from a noisy string.
function repairJson(s: string): string | null {
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
  }
  return null;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  const s = String(raw || "").trim();
  if (!s || s === "{}" || s === "[]") return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    const repaired = repairJson(s);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return { _raw: raw };
  }
}

// ---- Modes ----

export interface RunResult {
  content: string;
  plan?: string;
  verdict?: string;
  todos?: string[];
  todoState?: string[];
  toolCalls: ToolCallMeta[];
  phases: string[];
}

// Single agent with tools.
export async function runLocalAgent(opts: {
  settings: LocalSettings;
  messages: { role: string; content: string }[];
  system: string;
  onEvent: (e: ChatStreamEvent) => void;
}): Promise<RunResult> {
  const messages: LLMMessage[] = [{ role: "system", content: opts.system }, ...opts.messages.map((m) => ({ role: m.role, content: m.content }))];
  const phases: string[] = [];
  opts.onEvent({ kind: "phase", data: { phase: "executing" } });
  phases.push("executing");
  const { content, toolCalls } = await executeTurn(opts.settings, messages, opts.onEvent);
  opts.onEvent({ kind: "done", data: {} });
  return { content, toolCalls, phases };
}

// Multi-agent crew: Planner -> Executor -> Reviewer.
export async function runLocalCrew(opts: {
  settings: LocalSettings;
  userRequest: string;
  system: string;
  onEvent: (e: ChatStreamEvent) => void;
}): Promise<RunResult> {
  const phases: string[] = [];
  const emit = (e: ChatStreamEvent) => opts.onEvent(e);

  // 1. Planner
  emit({ kind: "phase", data: { phase: "planning" } });
  phases.push("planning");
  const planner = await chatComplete(opts.settings, [
    { role: "system", content: "You are the Planner of the Hermes Forge agent crew. Given a user request, produce a concise numbered execution plan (2-6 steps). Each step should say exactly what tool to call or what reasoning to do. Output ONLY the plan." },
    { role: "user", content: `User request:\n"""\n${opts.userRequest}\n"""\n\nProduce the execution plan.` },
  ], []);
  const plan = (planner.content || "1. Reason directly and answer.").trim();
  const todos = parseTodos(plan);
  emit({ kind: "phase", data: { phase: "executing", plan, todos } });
  phases.push("executing");

  // 2. Executor
  const messages: LLMMessage[] = [
    { role: "system", content: `You are the Executor of the Hermes Forge agent crew, powered by the Hermes model family. You receive a plan and a user request. You execute the plan step by step, CALLING TOOLS whenever they help. Present the final answer clearly.` },
    { role: "user", content: `User request:\n"""\n${opts.userRequest}\n"""\n\nPlan:\n${plan}\n\nExecute it now and deliver the final answer.` },
  ];
  let todoState = todos.map(() => "pending");
  let todoIdx = -1;
  const track = (e: ChatStreamEvent) => {
    if (e.kind === "tool_start") {
      todoIdx = Math.min(todoIdx + 1, todoState.length - 1);
      if (todoIdx >= 0) todoState[todoIdx] = "running";
      emit({ kind: "phase", data: { phase: "todo", todoState: [...todoState] } });
    } else if (e.kind === "tool_result") {
      if (todoIdx >= 0 && todoState[todoIdx] === "running") {
        todoState[todoIdx] = "done";
        emit({ kind: "phase", data: { phase: "todo", todoState: [...todoState] } });
      }
    }
    emit(e);
  };
  const { content, toolCalls } = await executeTurn(opts.settings, messages, track);
  todoState = todoState.map(() => "done");
  emit({ kind: "phase", data: { phase: "todo", todoState } });

  // 3. Reviewer
  emit({ kind: "phase", data: { phase: "reviewing" } });
  phases.push("reviewing");
  let verdict = "ACCEPT";
  try {
    const reviewer = await chatComplete(opts.settings, [
      { role: "system", content: "You are the Reviewer of the Hermes Forge agent crew. Given a user request and a candidate answer, verify correctness (arithmetic, consistency, completeness). If correct, reply exactly: ACCEPT. Otherwise reply with max 3 bullets prefixed with FIX:." },
      { role: "user", content: `User request:\n"""\n${opts.userRequest}\n"""\n\nCandidate answer:\n"""\n${content}\n"""\n\nReview it.` },
    ], []);
    verdict = (reviewer.content || "ACCEPT").trim();
  } catch {
    /* reviewer is best-effort */
  }
  emit({ kind: "phase", data: { phase: "done", verdict } });
  phases.push("done");

  return { content, plan, verdict, todos, todoState, toolCalls, phases };
}
