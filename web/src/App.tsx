import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, type ChatEvent } from "./api";
import MessageBubble, { useAutoScroll } from "./components/MessageBubble";
import { isNative } from "./env";
import { loadLocalSettings, saveLocalSettings, runLocalAgent, runLocalCrew, type LocalSettings, type ChatStreamEvent as LocalChatEvent } from "./localClient";
import {
  localListSessions,
  localGetSession,
  localNewSession,
  localAppend,
  localDelete,
} from "./localStore";
import type { Message, SessionSummary, Session, Settings, ToolCallMeta } from "./types";

const SUGGESTIONS = [
  { tag: "🧮", text: "Compute the 40th Fibonacci number and verify it with a code tool." },
  { tag: "🔢", text: "Use tools to calculate the sum of the first 100 prime numbers." },
  { tag: "🧠", text: "Store my preference (prefer concise answers) into memory, then recall it." },
  { tag: "⚡", text: "Run JavaScript to sort an array of 500 random numbers and show the top 5." },
];

let uidCounter = 0;
const nextId = () => `m_${Date.now()}_${uidCounter++}`;

interface UISettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  apiKey?: string;
  defaultSystem: string;
  maxTokens: number;
  temperature: number;
}

const native = isNative();

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState("New conversation");
  const [mode, setMode] = useState<"single" | "crew">("single");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<UISettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadSessions = useCallback(() => {
    if (native) {
      setSessions(localListSessions());
    } else {
      api
        .listSessions()
        .then(setSessions)
        .catch(() => {});
    }
  }, []);

  const loadSettings = useCallback(() => {
    if (native) {
      const s = loadLocalSettings();
      setSettings({ baseUrl: s.baseUrl, model: s.model, hasKey: Boolean(s.apiKey), apiKey: s.apiKey, defaultSystem: "", maxTokens: s.maxTokens, temperature: s.temperature });
    } else {
      api
        .getSettings()
        .then((s) => setSettings({ baseUrl: s.llmBaseUrl, model: s.llmModel, hasKey: s.hasKey, defaultSystem: s.defaultSystem, maxTokens: s.maxTokens, temperature: s.temperature }))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadSettings();
  }, [loadSessions, loadSettings]);

  useAutoScroll(scrollRef, [messages, streaming, error]);

  const openSession = useCallback((id: string) => {
    setShowDrawer(false);
    if (native) {
      const s = localGetSession(id);
      if (!s) return;
      setSessionId(s.id);
      setTitle(s.messages.find((m) => m.role === "user")?.content?.slice(0, 48) || "New conversation");
      setMessages(s.messages || []);
      setError(null);
    } else {
      api
        .getSession(id)
        .then((s: Session) => {
          setSessionId(s.id);
          setTitle(s.title);
          setMessages(s.messages || []);
          setError(null);
        })
        .catch(() => {});
    }
  }, []);

  const newChat = useCallback(() => {
    setShowDrawer(false);
    if (native) {
      const id = localNewSession();
      setSessionId(id);
      setTitle("New conversation");
      setMessages([]);
      setError(null);
      loadSessions();
    } else {
      api.newSession().then((s) => {
        setSessionId(s.id);
        setTitle(s.title);
        setMessages([]);
        setError(null);
        loadSessions();
      });
    }
  }, [loadSessions]);

  const deleteSession = useCallback(
    (id: string) => {
      if (native) {
        localDelete(id);
        if (sessionId === id) {
          setSessionId(null);
          setTitle("New conversation");
          setMessages([]);
        }
        loadSessions();
      } else {
        api.deleteSession(id).then(() => {
          if (sessionId === id) {
            setSessionId(null);
            setTitle("New conversation");
            setMessages([]);
          }
          loadSessions();
        });
      }
    },
    [sessionId, loadSessions],
  );

  const handleSend = useCallback(
    async (text: string, forceMode?: "single" | "crew") => {
      const content = text.trim();
      if (!content || streaming) return;
      setStreaming(true);
      setError(null);

      const userMsg: Message = { id: nextId(), role: "user", content, ts: Date.now() };
      const asstMsg: Message = {
        id: nextId(),
        role: "assistant",
        content: "",
        mode: forceMode || mode,
        meta: { toolCalls: [] },
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg, asstMsg]);
      setInput("");

      if (native) {
        const sid = sessionId || localNewSession();
        if (!sessionId) {
          setSessionId(sid);
          loadSessions();
        }
        localAppend(sid, userMsg);

        const toolCalls = new Map<number, ToolCallMeta>();
        const liveId = asstMsg.id;
        const patchAssistant = (fn: (m: Message) => Message) => {
          setMessages((prev) => prev.map((m) => (m.id === liveId ? fn(m) : m)));
        };

        function handleLocalEvent(e: LocalChatEvent) {
          if (e.kind === "delta") {
            const t = (e.data as { text: string }).text;
            patchAssistant((m) => ({ ...m, content: m.content + t }));
          } else if (e.kind === "tool_start") {
            const d = e.data as { name: string; arguments: string };
            const existing = Array.from(toolCalls.values()).find((t) => t.name === d.name && !t.result);
            if (existing) {
              existing.status = "running";
              existing.arguments = d.arguments;
            } else {
              const tc: ToolCallMeta = { name: d.name, arguments: d.arguments, status: "running" };
              toolCalls.set(toolCalls.size, tc);
            }
            patchAssistant((m) => ({ ...m, meta: { ...m.meta, toolCalls: Array.from(toolCalls.values()) } }));
          } else if (e.kind === "tool_result") {
            const d = e.data as { name: string; result: string };
            for (const t of toolCalls.values()) {
              if (t.name === d.name && t.status === "running") {
                t.status = "done";
                t.result = d.result;
              }
            }
            patchAssistant((m) => ({ ...m, meta: { ...m.meta, toolCalls: Array.from(toolCalls.values()) } }));
          } else if (e.kind === "phase") {
            const d = e.data as { phase: string; plan?: string; verdict?: string; todos?: string[]; todoState?: string[] };
            if (d.phase === "executing" && d.plan) {
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, plan: d.plan } }));
            }
            if (d.phase === "executing" && d.todos) {
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, todos: d.todos, todoState: d.todos!.map(() => "pending") } }));
            }
            if (d.phase === "todo" && d.todoState) {
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, todoState: d.todoState } }));
            }
            if (d.phase === "done" && d.verdict) {
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, verdict: d.verdict } }));
            }
          } else if (e.kind === "error") {
            setError((e.data as { message: string }).message);
          }
        }

        const ls = loadLocalSettings();
        if (!ls.baseUrl) {
          setError("Configure a model endpoint in Settings first.");
          setStreaming(false);
          return;
        }

        const history = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.content }));

        try {
          const effMode = forceMode || mode;
          const sys = ls.baseUrl.includes("8787")
            ? "You are Hermes Forge running on Android, an agentic assistant with tools, memory and code execution."
            : settings?.defaultSystem || "You are Hermes Forge, a powerful agentic assistant built on the Hermes model family.";

          const result = effMode === "crew"
            ? await runLocalCrew({
                settings: ls,
                userRequest: content,
                system: sys,
                onEvent: handleLocalEvent,
              })
            : await runLocalAgent({
                settings: ls,
                system: sys,
                messages: history,
                onEvent: handleLocalEvent,
              });

          const persisted: Message = {
            ...asstMsg,
            content: result.content,
            meta: { plan: result.plan, verdict: result.verdict, toolCalls: result.toolCalls, todos: result.todos, todoState: result.todoState },
            ts: Date.now(),
          };
          setMessages((prev) => prev.map((m) => (m.id === liveId ? persisted : m)));
          localAppend(sid, persisted);
          setTitle(userMsg.content.slice(0, 48));
          loadSessions();
        } catch (err) {
          setError((err as Error).message);
          patchAssistant((m) => (m.content ? m : { ...m, content: "_(request failed)_" }));
        } finally {
          setStreaming(false);
        }
        return;
      }

      // Web backend path
      const toolCalls = new Map<number, ToolCallMeta>();
      const liveId = asstMsg.id;
      const patchAssistant = (fn: (m: Message) => Message) => {
        setMessages((prev) => prev.map((m) => (m.id === liveId ? fn(m) : m)));
      };

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamChat(
          { sessionId: sessionId || undefined, message: content, mode: forceMode || mode },
          (e: ChatEvent) => {
            if (e.event === "session") {
              const sid = (e.data as { sessionId: string }).sessionId;
              setSessionId(sid);
              loadSessions();
            } else if (e.event === "delta") {
              const { text } = e.data as { text: string };
              patchAssistant((m) => ({ ...m, content: m.content + text }));
            } else if (e.event === "tool_delta") {
              const d = e.data as { index: number; function?: { name?: string; arguments?: string } };
              const idx = d.index ?? 0;
              if (!toolCalls.has(idx)) toolCalls.set(idx, { name: "", arguments: "", status: "running" });
              const existing = toolCalls.get(idx)!;
              if (d.function?.name) existing.name += d.function.name;
              if (d.function?.arguments) existing.arguments += d.function.arguments;
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, toolCalls: Array.from(toolCalls.values()) } }));
            } else if (e.event === "tool_start") {
              for (const [, t] of toolCalls) t.status = "running";
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, toolCalls: Array.from(toolCalls.values()) } }));
            } else if (e.event === "tool_result") {
              const { name, result } = e.data as { name: string; result: string };
              for (const [, t] of toolCalls) {
                if (t.name === name) {
                  t.status = "done";
                  t.result = result;
                }
              }
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, toolCalls: Array.from(toolCalls.values()) } }));
            } else if (e.event === "phase") {
              const d = e.data as { phase: string; plan?: string; verdict?: string; todos?: string[]; todoState?: string[] };
              if (d.phase === "executing" && d.plan) {
                patchAssistant((m) => ({ ...m, meta: { ...m.meta, plan: d.plan } }));
              }
              if (d.phase === "executing" && d.todos) {
                patchAssistant((m) => ({ ...m, meta: { ...m.meta, todos: d.todos, todoState: d.todos!.map(() => "pending") } }));
              }
              if (d.phase === "todo" && d.todoState) {
                patchAssistant((m) => ({ ...m, meta: { ...m.meta, todoState: d.todoState } }));
              }
              if (d.phase === "done" && d.verdict) {
                patchAssistant((m) => ({ ...m, meta: { ...m.meta, verdict: d.verdict } }));
              }
            } else if (e.event === "done") {
              const { sessionId: sid, title: t } = e.data as { sessionId: string; title?: string };
              if (t) setTitle(t);
              if (sid) setSessionId(sid);
              loadSessions();
            } else if (e.event === "error") {
              setError((e.data as { message: string }).message);
            }
          },
        );
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError((err as Error).message);
          patchAssistant((m) => (m.content ? m : { ...m, content: "_(request failed)_" }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [sessionId, mode, streaming, loadSessions, messages, settings],
  );

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const saveSettings = (patch: Partial<UISettings>) => {
    if (native) {
      const next = saveLocalSettings({
        baseUrl: patch.baseUrl,
        apiKey: patch.apiKey,
        model: patch.model,
        maxTokens: patch.maxTokens,
        temperature: patch.temperature,
      } as Partial<LocalSettings>);
      setSettings({ baseUrl: next.baseUrl, model: next.model, hasKey: Boolean(next.apiKey), apiKey: next.apiKey, defaultSystem: patch.defaultSystem || "", maxTokens: next.maxTokens, temperature: next.temperature });
    } else {
      api.saveSettings({
        llmBaseUrl: patch.baseUrl,
        llmApiKey: patch.apiKey,
        llmModel: patch.model,
        defaultSystem: patch.defaultSystem,
        maxTokens: patch.maxTokens,
        temperature: patch.temperature,
      } as Partial<Settings>).then((s) => setSettings({ baseUrl: s.llmBaseUrl, model: s.llmModel, hasKey: s.hasKey, defaultSystem: s.defaultSystem, maxTokens: s.maxTokens, temperature: s.temperature }));
    }
    setShowSettings(false);
  };

  return (
    <div className="app">
      <div className="statusbar" />
      <header className="header">
        <button className="icon-btn" onClick={() => setShowDrawer(true)} aria-label="Sessions">☰</button>
        <div className="avatar">H</div>
        <div className="title-box">
          <h1>{title}</h1>
          <div className="sub">{settings ? settings.model : "Hermes Forge"}</div>
        </div>
        <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings">⚙</button>
      </header>

      <div className="mode-row">
        <div className="mode-seg">
          <button className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>
            Agent
          </button>
          <button className={mode === "crew" ? "active" : ""} onClick={() => setMode("crew")}>
            Crew
          </button>
        </div>
      </div>

      <div className="chat" ref={scrollRef}>
        <div className="messages">
          {messages.length === 0 && !streaming && (
            <div className="empty-state">
              <div className="big-logo">H</div>
              <h2>Hermes Forge</h2>
              <p>
                {native
                  ? "A local-first agent with tools, memory and a Planner→Executor→Reviewer crew. Point it at your Hermes endpoint in Settings."
                  : "Agent + crew orchestration, built on the Hermes model family. Tools, memory, streaming."}
              </p>
              {!native && (
                <a className="apk-download" href="/download/hermes-forge-v1.0.apk" download="hermes-forge-v1.0.apk">
                  <span className="apk-dl-badge">APK</span>
                  <span>
                    <strong>Android app</strong>
                    <small>Signed release build (3 MB)</small>
                  </span>
                </a>
              )}
              <div className="hints">
                {SUGGESTIONS.map((s) => (
                  <button key={s.text} className="hint" onClick={() => handleSend(s.text)}>
                    <span className="hint-tag">{s.tag}</span>
                    {s.text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {error && <div className="error-banner">⚠ {error}</div>}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask something — tools, compute, memory…"
            rows={Math.min(5, Math.max(1, input.split("\n").length))}
          />
          {streaming ? (
            <button className="stop-btn" onClick={stop}>Stop</button>
          ) : (
            <button className="send-btn" onClick={() => handleSend(input)} disabled={!input.trim()}>➤</button>
          )}
        </div>
      </div>

      {showDrawer && (
        <>
          <div className="sheet-overlay" onClick={() => setShowDrawer(false)} />
          <div className="drawer">
            <div className="drawer-head">
              <h2>Conversations</h2>
              <button className="icon-btn" onClick={() => setShowDrawer(false)}>✕</button>
            </div>
            <button className="new-chat-btn" onClick={newChat}>＋ New conversation</button>
            <div className="session-list">
              {sessions.length === 0 && (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-3)", fontSize: 13 }}>No conversations yet</div>
              )}
              {sessions.map((s) => (
                <div key={s.id} className={`session-item ${s.id === sessionId ? "active" : ""}`} onClick={() => openSession(s.id)}>
                  <span className="s-title">{s.title}</span>
                  <span className="s-count">{s.messageCount}</span>
                  <button className="del" title="Delete" onClick={(ev) => { ev.stopPropagation(); deleteSession(s.id); }}>×</button>
                </div>
              ))}
            </div>
            <div className="drawer-foot">
              <div style={{ fontSize: 11.5, color: "var(--text-3)", textAlign: "center" }}>
                {native ? "All data stays on this device." : "Sessions stored server-side."}
              </div>
            </div>
          </div>
        </>
      )}

      {showSettings && (
        <>
          <div className="sheet-overlay" onClick={() => setShowSettings(false)} />
          <SettingsModal settings={settings} onSave={saveSettings} onClose={() => setShowSettings(false)} />
        </>
      )}
    </div>
  );
}

function SettingsModal({
  settings,
  onSave,
  onClose,
}: {
  settings: UISettings | null;
  onSave: (patch: Partial<UISettings>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    baseUrl: settings?.baseUrl || "",
    apiKey: "",
    model: settings?.model || "",
    defaultSystem: settings?.defaultSystem || "",
    maxTokens: settings?.maxTokens || 4096,
    temperature: settings?.temperature || 0.7,
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="modal">
      <div className="grabber" />
      <h2>Settings</h2>
      <div className="modal-sub">
        {native
          ? "Point the app at your OpenAI-compatible Hermes endpoint. On a phone, 127.0.0.1 is the phone itself — use your computer's LAN IP (e.g. http://192.168.x.x:8787/v1) or a public URL."
          : "Any OpenAI-compatible endpoint works with Hermes models (OpenRouter, Nous, NIM, vLLM...)."}
      </div>

      {!native && (
        <a className="apk-download" href="/download/hermes-forge-v1.0.apk" download="hermes-forge-v1.0.apk">
          <span className="apk-dl-badge">APK</span>
          <span>
            <strong>Android app</strong>
            <small>Download the signed Hermes Forge build</small>
          </span>
        </a>
      )}

      <label>Base URL</label>
      <input value={form.baseUrl} onChange={set("baseUrl")} placeholder="http://192.168.1.100:8787/v1" />

      <label>API key</label>
      <input
        type="password"
        value={form.apiKey}
        onChange={set("apiKey")}
        placeholder={settings?.hasKey ? "•••••••• (configured — leave blank to keep)" : "sk-... (optional for local)"}
      />
      <div className={`key-status ${settings?.hasKey ? "ok" : "missing"}`}>
        {settings?.hasKey ? "An API key is configured." : "No API key configured yet."}
      </div>

      <label>Model</label>
      <input value={form.model} onChange={set("model")} placeholder="hermes / hermes-4" />

      <label>System prompt</label>
      <textarea value={form.defaultSystem} onChange={set("defaultSystem")} />

      <div className="row">
        <div>
          <label>Max tokens</label>
          <input type="number" value={form.maxTokens} onChange={set("maxTokens")} />
        </div>
        <div>
          <label>Temperature</label>
          <input type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={set("temperature")} />
        </div>
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          onClick={() =>
            onSave({
              baseUrl: form.baseUrl,
              ...(form.apiKey ? { apiKey: form.apiKey } : {}),
              model: form.model,
              defaultSystem: form.defaultSystem,
              maxTokens: Number(form.maxTokens) || 4096,
              temperature: Number(form.temperature) || 0.7,
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}
