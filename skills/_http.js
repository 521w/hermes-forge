const DEFAULT_UA = "HermesForge/1.0";

async function httpGet(url, headers = {}, timeoutMs = 15_000) {
  const base = { "User-Agent": DEFAULT_UA, ...headers };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (globalThis.Capacitor?.Http) {
      const res = await globalThis.Capacitor.Http.get({
        url,
        headers: base,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      const data = res.data;
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        headers: res.headers || {},
        text: async () => String(data ?? ""),
        arrayBuffer: async () => new TextEncoder().encode(String(data ?? "")).buffer,
        json: async () => (typeof data === "object" && data !== null ? data : JSON.parse(String(data ?? "{}"))),
      };
    }
    return await fetch(url, { headers: base, signal: ctrl.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("request timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function httpPost(url, body, headers = {}, timeoutMs = 15_000) {
  const base = { "Content-Type": "application/json", "User-Agent": DEFAULT_UA, ...headers };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (globalThis.Capacitor?.Http) {
      const res = await globalThis.Capacitor.Http.post({
        url,
        headers: base,
        data: body,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      const data = res.data;
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => String(data ?? ""),
        json: async () => (typeof data === "object" && data !== null ? data : JSON.parse(String(data ?? "{}"))),
      };
    }
    return await fetch(url, { method: "POST", headers: base, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("request timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

export { httpGet, httpPost, b64ToUtf8 };
