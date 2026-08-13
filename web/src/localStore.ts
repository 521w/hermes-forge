import type { Message, SessionSummary } from "./types";

const KEY = "hf_sessions";
let cache: Record<string, Message[]> | undefined;

function loadAll(): Record<string, Message[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, Message[]>;
  } catch {
    cache = {};
  }
  return cache || {};
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(loadAll()));
}

function list(): Record<string, Message[]> {
  return loadAll();
}

export function localListSessions(): SessionSummary[] {
  return Object.entries(list())
    .map(([id, msgs]) => {
      const firstUser = msgs.find((m) => m.role === "user");
      return {
        id,
        title: firstUser?.content?.slice(0, 48) || "New conversation",
        createdAt: msgs[0]?.ts ? new Date(msgs[0].ts).toISOString() : new Date().toISOString(),
        updatedAt: msgs[msgs.length - 1]?.ts ? new Date(msgs[msgs.length - 1].ts).toISOString() : new Date().toISOString(),
        messageCount: msgs.length,
      };
    })
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}

export function localGetSession(id: string): { id: string; messages: Message[] } | null {
  const all = loadAll();
  return all[id] ? { id, messages: all[id] } : null;
}

export function localNewSession(): string {
  const id = `local_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  loadAll()[id] = [];
  persist();
  return id;
}

export function localAppend(id: string, msg: Message) {
  const all = loadAll();
  all[id] = all[id] || [];
  all[id].push(msg);
  persist();
}

export function localDelete(id: string) {
  const all = loadAll();
  delete all[id];
  persist();
}

export function localRename(id: string, title: string) {
  const all = loadAll();
  if (all[id] && all[id].length) {
    all[id][0] = { ...all[id][0], content: title };
    persist();
  }
}
