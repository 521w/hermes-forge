import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, "../..");
export const DATA_DIR = path.join(ROOT_DIR, "server", "data");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(path.join(DATA_DIR, "sessions"));
ensureDir(path.join(DATA_DIR, "memory"));

export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const defaults = {
  // User-facing env vars; the operator fills these in.
  llmBaseUrl: process.env.USER_LLM_BASE_URL || "https://openrouter.ai/api/v1",
  llmApiKey: process.env.USER_LLM_API_KEY || "",
  llmModel: process.env.USER_LLM_MODEL || "nousresearch/hermes-4-405b",
  defaultSystem:
    process.env.USER_AGENT_SYSTEM ||
    "You are Hermes Forge, a powerful agentic assistant built on the Hermes model family. You reason step by step, use the provided tools whenever they help, and deliver precise, well-structured answers.",
  maxTokens: Number(process.env.USER_MAX_TOKENS || 4096),
  temperature: Number(process.env.USER_TEMPERATURE || 0.7),
  port: Number(process.env.PORT || 3001),
};

export function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export const MEMORY_DIR = path.join(DATA_DIR, "memory");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
