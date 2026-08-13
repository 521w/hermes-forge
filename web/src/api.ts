import type { SessionSummary, Session, Settings } from "./types";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listSessions: () => json<SessionSummary[]>("/api/sessions"),
  getSession: (id: string) => json<Session>(`/api/sessions/${id}`),
  newSession: () => json<Session>("/api/sessions", { method: "POST" }),
  deleteSession: (id: string) => json<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  renameSession: (id: string, title: string) =>
    json<Session>(`/api/sessions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }),
  getSettings: () => json<Settings>("/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    json<Settings>("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }),
  getTools: () => json<{ name: string; description: string }[]>("/api/tools"),
};

export interface ChatEvent {
  event: string;
  data: unknown;
}

export async function streamChat(
  body: { sessionId?: string; message: string; mode: "single" | "crew"; system?: string },
  onEvent: (e: ChatEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const eventMatch = part.match(/^event: (.+)$/m);
      const dataMatch = part.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;
      let data: unknown;
      try {
        data = JSON.parse(dataMatch[1]);
      } catch {
        data = dataMatch[1];
      }
      onEvent({ event: eventMatch[1], data });
    }
  }
}
