import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HermesClient } from "./llm.js";
import { toolSchema } from "./tools.js";
import { loadSettings, saveSettings, ROOT_DIR } from "./config.js";
import { listSessions, getSession, createSession, appendMessage, patchSession, deleteSession, isValidSessionId } from "./store.js";
import { runSingleAgent, runCrew } from "./agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "4mb" }));

app.use((err, _req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON in request body." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }
  next(err);
});

function buildClient() {
  const s = loadSettings();
  return { settings: s, client: new HermesClient({ baseUrl: s.llmBaseUrl, apiKey: s.llmApiKey, model: s.llmModel }) };
}

// ---- SSE chat ----
app.post("/api/chat", async (req, res) => {
  const { sessionId, mode = "single", system } = req.body || {};
  const userText = (req.body?.message || "").trim();
  if (!userText) {
    return res.status(400).json({ error: "message is required" });
  }

  const { settings, client } = buildClient();
  if (!client.apiKey) {
    return res.status(400).json({ error: "No LLM API key configured. Open settings and set an OpenAI-compatible API key." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const session = sessionId && isValidSessionId(sessionId) ? getSession(sessionId) || createSession() : createSession();
  const effSystem = system || settings.defaultSystem;

  const history = (session.messages || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content)
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));

  appendMessage(session.id, { role: "user", content: userText, ts: Date.now() });
  send("session", { sessionId: session.id });

  const onDelta = (d) => {
    if (d.text) send("delta", { text: d.text });
    if (d.toolCallDelta) send("tool_delta", d.toolCallDelta);
    if (d.toolStart) send("tool_start", d.toolStart);
    if (d.toolResult) send("tool_result", { name: d.toolResult.name, result: String(d.toolResult.result).slice(0, 2000) });
    if (d.phase) send("phase", { phase: d.phase, plan: d.plan, verdict: d.verdict, todos: d.todos, todoState: d.todoState });
  };

  try {
    let result;
    if (mode === "crew") {
      result = await runCrew({
        client,
        userRequest: userText,
        tools: toolSchema(),
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        onDelta,
      });
      appendMessage(session.id, { role: "assistant", content: result.content, mode, meta: { plan: result.plan, verdict: result.verdict, toolCalls: result.toolCalls, todos: result.todos }, ts: Date.now() });
    } else {
      const messages = [{ role: "system", content: effSystem }, ...history];
      result = await runSingleAgent({
        client,
        messages,
        tools: toolSchema(),
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        onDelta,
      });
      appendMessage(session.id, { role: "assistant", content: result.content, mode, meta: { toolCalls: result.toolCalls }, ts: Date.now() });
    }

    send("done", { sessionId: session.id, title: (getSession(session.id) || {}).title });
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

// ---- Sessions ----
app.get("/api/sessions", (_req, res) => res.json(listSessions()));

app.get("/api/sessions/:id", (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(400).json({ error: "invalid session id" });
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

app.post("/api/sessions", (_req, res) => res.json(createSession()));

app.delete("/api/sessions/:id", (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(400).json({ error: "invalid session id" });
  if (!deleteSession(req.params.id)) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.patch("/api/sessions/:id", (req, res) => {
  if (!isValidSessionId(req.params.id)) return res.status(400).json({ error: "invalid session id" });
  const s = patchSession(req.params.id, req.body || {});
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// ---- Tools ----
app.get("/api/tools", (_req, res) => {
  res.json(toolSchema().map((t) => ({ name: t.function.name, description: t.function.description })));
});

// ---- Settings ----
app.get("/api/settings", (_req, res) => {
  const s = loadSettings();
  res.json({
    llmBaseUrl: s.llmBaseUrl,
    llmModel: s.llmModel,
    hasKey: Boolean(s.llmApiKey),
    defaultSystem: s.defaultSystem,
    maxTokens: s.maxTokens,
    temperature: s.temperature,
  });
});

app.post("/api/settings", (req, res) => {
  const patch = {};
  for (const k of ["llmBaseUrl", "llmApiKey", "llmModel", "defaultSystem", "maxTokens", "temperature"]) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  const next = saveSettings(patch);
  res.json({
    llmBaseUrl: next.llmBaseUrl,
    llmModel: next.llmModel,
    hasKey: Boolean(next.llmApiKey),
    defaultSystem: next.defaultSystem,
    maxTokens: next.maxTokens,
    temperature: next.temperature,
  });
});

// ---- Health + static frontend ----
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

const downloadsDir = path.join(ROOT_DIR, "server", "downloads");
app.get("/download/:file", (req, res) => {
  const file = path.basename(req.params.file);
  const target = path.join(downloadsDir, file);
  if (!file || !fs.existsSync(target)) {
    return res.status(404).json({ error: "file not found" });
  }
  res.sendFile(target);
});

const webDist = path.join(ROOT_DIR, "web", "dist");
app.use(express.static(webDist));
app.get(/^\/(?!api\/)(?!download\/).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

const port = loadSettings().port;
const server = app.listen(port, () => {
  console.log(`[Hermes Forge] API + static server on http://localhost:${port}`);
});

// Without this the process ignores SIGTERM/SIGINT, so `npm run dev` (concurrently)
// leaves the port occupied after Ctrl-C and the next start fails with EADDRINUSE.
let shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Hermes Forge] ${signal} received, shutting down.`);
  // Force exit if lingering SSE connections keep the server open.
  const force = setTimeout(() => {
    console.warn("[Hermes Forge] shutdown timed out, forcing exit.");
    process.exit(exitCode || 1);
  }, 5000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    process.exit(exitCode);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A stray rejection anywhere in the process would otherwise take the whole API
// down mid-conversation; log it with context and keep serving. Uncaught
// exceptions are genuine corruption, so those still stop the process — after
// releasing the port so a supervisor can restart cleanly, and with a non-zero
// code so CI and process managers can tell a crash from a clean shutdown.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Hermes Forge] unhandled rejection:", reason, "at", promise);
});

process.on("uncaughtException", (err) => {
  console.error("[Hermes Forge] uncaught exception:", err);
  shutdown("uncaughtException", 1);
});

export { app, server };
