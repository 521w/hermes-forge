export class HermesClient {
  constructor({ baseUrl, apiKey, model }) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.model = model || "";
  }

  _endpoint() {
    return `${this.baseUrl}/chat/completions`;
  }

  _headers() {
    const headers = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  _httpError(res, body) {
    const message =
      (body && (body.error?.message || body.error || JSON.stringify(body))) ||
      `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    return err;
  }

  // Non-streaming completion with tool support.
  async complete({ messages, tools = [], temperature = 0.7, maxTokens = 4096, stop }) {
    const payload = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (tools && tools.length) payload.tools = tools;
    if (stop) payload.stop = stop;

    let res;
    try {
      res = await fetch(this._endpoint(), {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const wrapped = new Error(`Network error reaching ${this.baseUrl}: ${err.message}`);
      wrapped.status = 0;
      throw wrapped;
    }

    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }

    if (!res.ok) throw this._httpError(res, json);

    const choice = json?.choices?.[0];
    return {
      message: choice?.message || { role: "assistant", content: "", tool_calls: [] },
      finishReason: choice?.finish_reason || "stop",
      usage: json?.usage || {},
      raw: json,
    };
  }

  // Streaming completion with tool support.
  // Calls onDelta({text, toolCallDelta}) and resolves with the assembled message.
  async completeStream({ messages, tools = [], temperature = 0.7, maxTokens = 4096, onDelta, stop }) {
    const payload = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length) payload.tools = tools;
    if (stop) payload.stop = stop;

    let res;
    try {
      res = await fetch(this._endpoint(), {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      const wrapped = new Error(`Network error reaching ${this.baseUrl}: ${err.message}`);
      wrapped.status = 0;
      throw wrapped;
    }

    if (!res.ok || !res.body) {
      const body = await res.text();
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        /* ignore */
      }
      throw this._httpError(res, json);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCalls = [];
    let finishReason = "stop";
    let usage = {};

    const emitText = (text) => {
      if (onDelta && text) onDelta({ text });
    };

    const emitToolDelta = (call) => {
      if (onDelta && call) onDelta({ toolCallDelta: call });
    };

    // Accumulate streaming tool_calls by index. Some providers resend the full
    // arguments buffer on every chunk: if the new fragment is strictly longer
    // and a prefix of what we already have, replace instead of appending.
    const applyToolDelta = (toolCalls, tc) => {
      const idx = tc.index ?? 0;
      if (!toolCalls[idx]) {
        toolCalls[idx] = { id: tc.id || `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
      }
      const target = toolCalls[idx];
      if (tc.id) target.id = tc.id;
      if (tc.function?.name) target.function.name += tc.function.name;
      if (tc.function?.arguments) {
        const frag = tc.function.arguments;
        if (target.function.arguments && target.function.arguments.startsWith(frag) && frag.length > target.function.arguments.length) {
          target.function.arguments = frag;
        } else {
          target.function.arguments += frag;
        }
      }
      return { index: idx, ...target };
    };

    const flushChunk = (chunk) => {
      if (!chunk || chunk.trim() === "" || chunk.trim() === "data: [DONE]") return;
      let data;
      try {
        data = JSON.parse(chunk.replace(/^data:\s*/, ""));
      } catch {
        return;
      }
      if (data.usage) usage = data.usage;
      const delta = data.choices?.[0]?.delta || {};
      const fc = data.choices?.[0]?.finish_reason;
      if (fc) finishReason = fc;
      if (delta.content) {
        content += delta.content;
        emitText(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          emitToolDelta(applyToolDelta(toolCalls, tc));
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          flushChunk(trimmed);
        }
      }
    } catch (err) {
      const wrapped = new Error(`Stream interrupted from ${this.baseUrl}: ${err.message}`);
      wrapped.status = 0;
      throw wrapped;
    }
    if (buffer.trim()) flushChunk(buffer.trim());

    return {
      message: { role: "assistant", content, tool_calls: toolCalls },
      finishReason,
      usage,
    };
  }
}
