import { useState } from "react";
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, ToolCallMeta } from "../types";

const STATUS_ICON = { done: "✓", running: "…", pending: "○", error: "!" } as const;

// ---- Todo panel (Claude Code / Codex-style plan) ----
function TodoPanel({ todos, todoState }: { todos?: string[]; todoState?: string[] }) {
  if (!todos || !todos.length) return null;
  const hasState = Array.isArray(todoState) && todoState.length === todos.length;
  return (
    <div className="todo-panel">
      <div className="todo-head">Plan</div>
      {todos.map((t, i) => {
        const st = hasState ? (todoState[i] as keyof typeof STATUS_ICON) : "done";
        const cls = ["running", "done", "error"].includes(st) ? st : "pending";
        return (
          <div key={i} className={`todo-item ${cls}`}>
            <span className="todo-mark">{STATUS_ICON[cls] ?? "○"}</span>
            <span className="todo-text">{t}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---- Collapsible tool call card ----
function ToolCard({ tool }: { tool: ToolCallMeta }) {
  const [open, setOpen] = useState(true);
  const cls = tool.status === "done" ? "done" : tool.status === "error" ? "error" : "";
  const running = !tool.status || tool.status === "running";
  return (
    <div className={`tool-card ${cls}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-ico" />
        <span className="tool-name">{tool.name}</span>
        {running && <span className="tool-spin">running</span>}
        {tool.status === "done" && <span className="tool-done">✓</span>}
        {tool.status === "error" && <span className="tool-err">!</span>}
        <span className="tool-toggle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body">
          {tool.arguments && (
            <div className="tool-block">
              <div className="tool-block-label">args</div>
              <CodeBlock code={tool.arguments} />
            </div>
          )}
          {tool.result !== undefined && (
            <div className="tool-block">
              <div className="tool-block-label">result</div>
              <CodeBlock code={tool.result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Minimal syntax highlighting (JS/TS/JSON/Python-ish) ----
function tokenize(code: string) {
  const tokens: { text: string; cls: string }[] = [];
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("[^"\n]*"|'[^'\n]*'|`[^`]*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|async|await|import|export|from|new|class|try|catch|throw|typeof|switch|case|break|true|false|null|undefined|=>)\b|\b([A-Za-z_$][\w$]*)\b|\n/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) tokens.push({ text: code.slice(last, m.index), cls: "plain" });
    if (m[1]) tokens.push({ text: m[1], cls: "comment" });
    else if (m[2]) tokens.push({ text: m[2], cls: "str" });
    else if (m[3]) tokens.push({ text: m[3], cls: "num" });
    else if (m[4]) tokens.push({ text: m[4], cls: "kw" });
    else if (m[5]) tokens.push({ text: m[5], cls: "fn" });
    else if (m[0] === "\n") tokens.push({ text: m[0], cls: "plain" });
    last = re.lastIndex;
  }
  if (last < code.length) tokens.push({ text: code.slice(last), cls: "plain" });
  return tokens;
}

function CodeBlock({ code, className }: { code: string; className?: string }) {
  const lang = (className || "").replace(/^language-/, "");
  return (
    <pre className={`code-block${lang ? ` lang-${lang}` : ""}`}>
      {lang && <div className="code-lang">{lang}</div>}
      <code>
        {tokenize(code).map((t, i) =>
          t.cls === "plain" ? (
            <span key={i}>{t.text}</span>
          ) : (
            <span key={i} className={`tok-${t.cls}`}>
              {t.text}
            </span>
          ),
        )}
      </code>
    </pre>
  );
}

// ---- Phase chips ----
function PhaseChips({ message }: { message: Message }) {
  const meta = message.meta;
  if (message.mode !== "crew") {
    if (message.content) return null;
    return (
      <div className="meta-strip">
        <span className="chip live">running tools…</span>
      </div>
    );
  }
  const running = (meta?.toolCalls || []).some((t) => t.status === "running") || !message.content;
  return (
    <div className="meta-strip">
      {meta?.plan && <span className="chip done">plan ✓</span>}
      <span className={running ? "chip live" : "chip done"}>{running ? "executing…" : "executed ✓"}</span>
      {meta?.verdict && (
        <span className={`chip ${meta.verdict.trim().startsWith("ACCEPT") ? "done" : ""}`}>
          {meta.verdict.trim().startsWith("ACCEPT") ? "reviewed ✓" : "review: fix"}
        </span>
      )}
    </div>
  );
}

function AssistantBubble({ message }: { message: Message }) {
  const meta = message.meta;
  const tc = meta?.toolCalls || [];
  const running = tc.some((t) => t.status === "running");

  return (
    <div className="msg assistant">
      <PhaseChips message={message} />
      {meta?.plan && message.mode === "crew" && <div className="plan-block">{meta.plan}</div>}
      {meta?.todos && meta.todos.length > 0 && message.mode === "crew" && <TodoPanel todos={meta.todos} todoState={meta.todoState} />}
      {message.content ? (
        <div className="bubble markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              pre: ({ children }) => <div className="md-pre">{children}</div>,
              code: ({ className, children }) => (
                <CodeBlock code={String(children).replace(/\n$/, "")} className={className} />
              ),
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      ) : running ? (
        <div className="typing">
          calling tools<span>.</span><span>.</span><span>.</span>
        </div>
      ) : null}
      {tc.map((t, i) => (
        <ToolCard key={i} tool={t} />
      ))}
    </div>
  );
}

export default function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{message.content}</div>
      </div>
    );
  }
  return <AssistantBubble message={message} />;
}

export function useAutoScroll(ref: React.RefObject<HTMLDivElement>, deps: unknown[]) {
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = nearBottom;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
