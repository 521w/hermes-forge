import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "./config.js";

// Session ids come straight from the URL, so they must never be able to name a
// path. Only the UUIDs `createSession` mints (plus a conservative superset) are
// accepted: no separators, no `..`, bounded length. Without this, an id such as
// `..%2Fsettings` escaped SESSIONS_DIR and let a remote caller read, overwrite
// and delete arbitrary `.json` files — including the stored LLM API key.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSessionId(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id) && !id.includes("..");
}

function fileFor(id) {
  if (!isValidSessionId(id)) throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export function listSessions() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
      out.push({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: (s.messages || []).length,
      });
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getSession(id) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), "utf-8"));
  } catch {
    return null;
  }
}

export function createSession() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const session = {
    id,
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(id), JSON.stringify(session, null, 2), "utf-8");
  return session;
}

export function appendMessage(id, message) {
  const session = getSession(id) || createSession();
  session.messages.push(message);
  if (session.title === "New conversation" && message.role === "user") {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    session.title = text.slice(0, 48) || "New conversation";
  }
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(fileFor(id), JSON.stringify(session, null, 2), "utf-8");
  return session;
}

export function patchSession(id, patch) {
  const session = getSession(id);
  if (!session) return null;
  // Never let a request body replace id/messages wholesale; only the title is
  // meant to be user-editable.
  if (typeof patch?.title === "string") session.title = patch.title.slice(0, 200);
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(fileFor(id), JSON.stringify(session, null, 2), "utf-8");
  return session;
}

export function deleteSession(id) {
  if (!isValidSessionId(id)) return false;
  try {
    fs.rmSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}
