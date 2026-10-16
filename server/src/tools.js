import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MEMORY_DIR, ROOT_DIR } from "./config.js";

const ensureMemoryDir = () => fs.mkdirSync(MEMORY_DIR, { recursive: true });
const WORKSPACE = ROOT_DIR;
const SKILLS_DIR = path.join(ROOT_DIR, "skills");

// Blank out comments and string/template literals so lexical checks cannot be
// fooled by decoy text (and so real code is not hidden behind quoted noise).
function stripNonCode(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// `vm` cannot evaluate a dynamic import without a callback, and Node throws
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING from the ESM loader. When the
// resulting promise is not caught that rejection is *unhandled* and takes the
// whole server process down. Because codeGeneration.strings is disabled the
// keyword cannot be assembled at runtime, so a literal `import(` in the source
// is the whole attack surface: reject it with a clear error instead of a crash.
function assertNoDynamicImport(source) {
  if (/\bimport\s*[.(]/.test(stripNonCode(source))) {
    throw new Error(
      "Dynamic import is not allowed in the sandbox (it would terminate the host process).",
    );
  }
}

const SANDBOX_TIMEOUT_MS = 5000;

// Sandboxed code can create promises nobody ever observes: a bare
// `Promise.reject(1)`, or `void (async () => { throw ... })()`, is enough. Node
// terminates the process on an unhandled rejection, so one `run_js` call could
// take the whole server down. Promises born in the vm realm are not instances
// of the host `Promise`, which identifies them exactly; those are contained,
// while genuine host rejections keep Node's default fatal behaviour.
const sandboxRejections = [];

function installSandboxRejectionGuard() {
  if (installSandboxRejectionGuard.installed) return;
  installSandboxRejectionGuard.installed = true;
  process.on("unhandledRejection", (reason, promise) => {
    if (promise instanceof Promise) {
      process.nextTick(() => {
        throw reason;
      });
      return;
    }
    const message = reason && reason.message ? reason.message : String(reason);
    sandboxRejections.push(message);
    if (sandboxRejections.length > 20) sandboxRejections.shift();
  });
}

// This string is evaluated *inside* the sandbox realm. It must only use
// primitives that realm already owns, because any host object (even a plain
// host function such as `console.log`) exposes `Object` via `.constructor`
// and therefore `.constructor.constructor("return process")()`.
const SANDBOX_BOOTSTRAP = `
var __hermesOut = [];
function __hermesPrint(prefix, args) {
  var parts = Array.prototype.map.call(args, function (a) { return String(a); });
  __hermesOut.push(prefix + parts.join(" "));
}
var console = {
  log: function () { __hermesPrint("", arguments); },
  info: function () { __hermesPrint("", arguments); },
  warn: function () { __hermesPrint("warn: ", arguments); },
  error: function () { __hermesPrint("error: ", arguments); },
};
`;

async function safeEval(expression) {
  const source = String(expression ?? "").slice(0, 2000);
  assertNoDynamicImport(source);
  installSandboxRejectionGuard();
  // Null-prototype sandbox + no host objects injected: `this.constructor`,
  // `Object.constructor`, `console.log.constructor` and friends all resolve to
  // nothing, and codeGeneration.strings=false disables `new Function`.
  const sandbox = Object.create(null);
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(SANDBOX_BOOTSTRAP, sandbox, { timeout: SANDBOX_TIMEOUT_MS });

  sandboxRejections.length = 0;
  let result;
  try {
    result = vm.runInContext(source, sandbox, { timeout: SANDBOX_TIMEOUT_MS });
  } catch (err) {
    sandboxRejections.length = 0;
    throw err;
  }
  // `unhandledRejection` fires only after the microtask queue drains, so yield
  // one macrotask; otherwise a rejection this eval caused would be attributed
  // to whatever call happens to run next (or silently lost).
  await new Promise((resolve) => setImmediate(resolve));
  const escaped = sandboxRejections.slice();
  sandboxRejections.length = 0;

  const logged = vm.runInContext("__hermesOut.join('\\n')", sandbox);

  let value;
  if (typeof result === "object" && result !== null) {
    value = JSON.stringify(result, null, 2);
  } else if (result !== undefined) {
    value = String(result);
  } else {
    value = "";
  }

  const parts = [];
  if (logged) parts.push(logged);
  if (value) parts.push(value);
  if (escaped.length) parts.push(`Unhandled rejection: ${escaped.join("; ")}`);
  return parts.join("\n");
}

// Resolve a user-supplied relative path inside the workspace, blocking traversal.
function resolvePath(p) {
  const target = path.resolve(WORKSPACE, String(p || "."));
  if (target !== WORKSPACE && !target.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`Path outside workspace is not allowed: ${p}`);
  }
  return target;
}

async function readFile(p, opts = {}) {
  const target = resolvePath(p);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`File not found: ${p}`);
  }
  const maxBytes = Math.min(Number(opts.maxBytes) || 200_000, 1_000_000);
  const buf = fs.readFileSync(target);
  const text = buf.toString("utf-8").slice(0, maxBytes);
  return text.length < buf.length ? `${text}\n...(truncated, file larger than ${maxBytes} bytes)` : text;
}

async function writeFile(p, content = "") {
  const target = resolvePath(p);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const data = String(content ?? "");
  if (data.length > 2_000_000) throw new Error("Content too large (max 2MB)");
  fs.writeFileSync(target, data, "utf-8");
  return `Wrote ${Buffer.byteLength(data, "utf-8")} bytes to ${p}`;
}

async function listDir(p) {
  const target = resolvePath(p);
  if (!fs.existsSync(target)) throw new Error(`Path not found: ${p}`);
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const rows = entries
    .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
    .sort();
  const truncated = rows.slice(0, 200);
  return `[${target}]\n${truncated.join("\n")}${rows.length > 200 ? `\n...(${rows.length - 200} more)` : ""}`;
}

async function grepFiles(pattern, { include = "*", path: p = "." } = {}) {
  const target = resolvePath(p);
  if (!fs.existsSync(target)) throw new Error(`Path not found: ${p}`);
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`Invalid regex: ${err.message}`);
  }
  const includeRe = new RegExp(include.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i");
  const results = [];
  const walk = (dir, depth) => {
    if (depth > 6 || results.length >= 50) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (includeRe.test(e.name)) {
        try {
          const text = fs.readFileSync(full, "utf-8");
          for (const line of text.split("\n").slice(0, 2000)) {
            if (re.test(line)) {
              const rel = path.relative(WORKSPACE, full);
              results.push(`${rel}:${line.slice(0, 300)}`);
              if (results.length >= 50) break;
            }
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(target, 0);
  return results.length ? results.join("\n") : "No matches.";
}

async function webFetch(url, opts = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("URL must start with http(s)://");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "HermesForge/1.0 (+agentic assistant)",
        Accept: "text/html,text/plain,application/json",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const ct = res.headers.get("content-type") || "";
    const maxBytes = Math.min(Number(opts.maxBytes) || 500_000, 1_000_000);
    const body = await res.arrayBuffer();
    const sliced = Buffer.from(body.slice(0, maxBytes));
    if (ct.includes("text/html")) {
      const text = sliced.toString("utf-8");
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();
      return `Title/HTML text from ${url}:\n${stripped.slice(0, maxBytes)}`;
    }
    return sliced.toString("utf-8");
  } finally {
    clearTimeout(t);
  }
}

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Evaluate a math expression (support + - * / ** % parentheses, Math.* functions). Returns a number. Use this instead of guessing arithmetic.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Math expression, e.g. (3 * 7 + 1) ** 2 / Math.sqrt(16)" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time in a given timezone (IANA name). No args returns local server time.",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone e.g. Asia/Shanghai, America/New_York" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_js",
      description:
        "Execute a small sandboxed JavaScript snippet to compute or transform data. console.log output is returned.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to run. console.log(...) prints to output." },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file from the project workspace. Use this to inspect code, configs or docs before reasoning about them.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root, e.g. server/src/tools.js" },
          maxBytes: { type: "integer", description: "Optional cap on bytes read (default 200000)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file inside the project workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
          content: { type: "string", description: "Full text content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and subdirectories in a workspace directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to project root (default '.')." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description:
        "Search file contents inside the workspace with a regex. Returns file paths and matching lines.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex to search for, e.g. 'TODO|FIXME'." },
          include: { type: "string", description: "Filename glob filter, e.g. '*.js' (default '*')." },
          path: { type: "string", description: "Directory to search, relative to project root (default '.')." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a web page and return its readable text. Useful for checking docs, APIs or public info.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to fetch." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_store",
      description:
        "Store a fact or note into long-term memory, keyed by topic. The agent can recall it later across sessions.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short topic key, e.g. user-preferences, project-facts" },
          value: { type: "string", description: "The fact or note to remember." },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description: "Recall all long-term memory entries for a topic key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Topic key to recall, e.g. user-preferences. Use '*' to recall all." },
        },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Full-text search across all long-term memory entries. Returns the most relevant stored facts for a query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search phrase or keywords, e.g. 'user prefers concise answers'." },
          limit: { type: "integer", description: "Max results to return (default 5)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fibonacci",
      description: "Compute the nth Fibonacci number (optimized, handles large n up to 1e6).",
      parameters: {
        type: "object",
        properties: {
          n: { type: "integer", description: "Index n (0-based)" },
        },
        required: ["n"],
      },
    },
  },
];

async function fibonacci(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (n > 1000000) return "n too large, max 1000000";
  let a = 0n;
  let b = 1n;
  for (let i = 0; i < n; i++) {
    [a, b] = [b, a + b];
  }
  const out = a.toString();
  return out.length > 500 ? `${out.slice(0, 500)}... (${out.length} digits total)` : out;
}

// ---- Skill framework: dynamically discover `skills/<name>/SKILL.md` and
// register each skill as a callable tool (Claude Code / Hermes Agent style).
function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  const meta = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return { meta, body: m ? md.slice(m[0].length) : md };
}

function discoverSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, entry.name);
    const mdPath = path.join(dir, "SKILL.md");
    if (!fs.existsSync(mdPath)) continue;
    const { meta, body } = parseFrontmatter(fs.readFileSync(mdPath, "utf-8"));
    skills.push({
      name: entry.name,
      description: meta.description || `Run the ${entry.name} skill.`,
      dir,
      instructions: body.trim(),
    });
  }
  return skills;
}

export const SKILLS = discoverSkills();

for (const s of SKILLS) {
  toolDefinitions.push({
    type: "function",
    function: {
      name: `skill_${s.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      description: `Skill: ${s.description}`,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: `The task or query to hand to the "${s.name}" skill.` },
        },
        required: ["input"],
      },
    },
  });
}

async function runSkill(name, input) {
  const skill = SKILLS.find((s) => s.name === name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);
  const exec = path.join(skill.dir, "index.js");
  if (fs.existsSync(exec)) {
    try {
      const mod = await import(pathToFileURL(exec).href);
      const fn = mod.default || mod.run;
      if (typeof fn === "function") return String(await fn(input));
    } catch (err) {
      return `Skill "${name}" execution failed: ${err.message}`;
    }
  }
  return `[${name} skill]\n${skill.instructions}`;
}

function getCurrentTime(timezone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || undefined,
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date());
  } catch {
    return new Date().toString();
  }
}

function memoryFile(key) {
  const safe = String(key || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return path.join(MEMORY_DIR, `${safe}.json`);
}

async function memoryStore(key, value) {
  ensureMemoryDir();
  const file = memoryFile(key);
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf-8") || "[]");
  } catch {
    entries = [];
  }
  entries.push({ value, at: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf-8");
  return `Stored under key "${key}". Now ${entries.length} entries.`;
}

async function memoryRecall(key) {
  ensureMemoryDir();
  if (key === "*") {
    const out = {};
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      if (f.endsWith(".json")) {
        out[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8"));
      }
    }
    return JSON.stringify(out);
  }
  try {
    const entries = JSON.parse(fs.readFileSync(memoryFile(key), "utf-8"));
    return JSON.stringify(entries);
  } catch {
    return `No memory found under key "${key}".`;
  }
}

// Simple full-text search over all memory entries: tokenize both sides and score by term hits.
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

async function memorySearch(query, limit) {
  ensureMemoryDir();
  const qTokens = tokenize(query);
  if (!qTokens.length) return "Query too short.";
  const hits = [];
  for (const f of fs.readdirSync(MEMORY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const key = f.replace(/\.json$/, "");
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const text = String(entry.value || "");
      const docTokens = tokenize(text);
      if (!docTokens.length) continue;
      let score = 0;
      const termSet = new Set(docTokens);
      for (const t of qTokens) if (termSet.has(t)) score += 1;
      if (score > 0) {
        const keyTokens = tokenize(key);
        for (const t of qTokens) if (keyTokens.includes(t)) score += 1.5;
        hits.push({ key, value: text, at: entry.at, score, matches: score });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, Math.min(Number(limit) || 5, 10));
  if (!top.length) return "No memory matches that query.";
  return JSON.stringify(top.map(({ key, value, at, score }) => ({ key, value, at, relevance: score })), null, 2);
}

export async function executeTool(name, args) {
  const a = args || {};
  if (name.startsWith("skill_")) {
    const toolKey = name.slice("skill_".length);
    const skill = SKILLS.find((s) => s.name.replace(/[^a-zA-Z0-9_]/g, "_") === toolKey);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return runSkill(skill.name, a.input);
  }
  switch (name) {
    case "calculate":
      return safeEval(a.expression);
    case "get_current_time":
      return getCurrentTime(a.timezone);
    case "run_js":
      return safeEval(a.code);
    case "read_file":
      return readFile(a.path, a);
    case "write_file":
      return writeFile(a.path, a.content);
    case "list_dir":
      return listDir(a.path);
    case "grep_files":
      return grepFiles(a.pattern, a);
    case "web_fetch":
      return webFetch(a.url, a);
    case "memory_store":
      return memoryStore(a.key, a.value);
    case "memory_recall":
      return memoryRecall(a.key);
    case "memory_search":
      return memorySearch(a.query, a.limit);
    case "fibonacci":
      return fibonacci(a.n);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function toolSchema() {
  return toolDefinitions;
}
