import http from "node:http";

const PORT = 3999;

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.url === "/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const messages = parsed.messages || [];
      const last = messages[messages.length - 1];
      const isToolResult = last?.role === "tool";
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;

      if (isToolResult) {
        // Round 2: emit final answer.
        if (parsed.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunks = [
            { choices: [{ delta: { content: "The answer is " } }] },
            { choices: [{ delta: { content: "42" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 99 } },
          ];
          for (const c of chunks) sse(res, c);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "ACCEPT" }, finish_reason: "stop" }],
            }),
          );
        }
        return;
      }

      // Requests without tools (planner/reviewer) just return text.
      if (!hasTools) {
        const text = isToolResult ? "ACCEPT" : "1. Call calculate with expression '6 * 7'.\n2. Verify the result.";
        if (parsed.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunks = [
            { choices: [{ delta: { content: text.slice(0, 20) } }] },
            { choices: [{ delta: { content: text.slice(20) } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 5 } },
          ];
          for (const c of chunks) sse(res, c);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
            }),
          );
        }
        return;
      }

      // Round 1: emit a tool call for calculate(6 * 7).
      const tc = {
        index: 0,
        id: "call_mock_1",
        type: "function",
        function: { name: "calculate", arguments: JSON.stringify({ expression: "6 * 7" }) },
      };
      if (parsed.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const arg1 = { expression: "6 * 7" };
        const argStr = JSON.stringify(arg1);
        const chunks = [
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "cal", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "culate", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(0, 5) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(5) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 10 } },
        ];
        for (const c of chunks) sse(res, c);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "", tool_calls: [{ id: "call_mock_1", type: "function", function: { name: "calculate", arguments: JSON.stringify({ expression: "6 * 7" }) } }] },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => console.log(`[mock-llm] listening on http://localhost:${PORT}`));
