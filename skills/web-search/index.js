import { httpGet } from "../_http.js";

const MAX_BYTES = 300_000;

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cleanUrl(href) {
  let h = stripHtml(href);
  if (h.startsWith("//")) h = "https:" + h;
  if (h.includes("uddg=")) {
    const m = /[?&]uddg=([^&]+)/.exec(h);
    if (m) {
      try {
        h = decodeURIComponent(m[1]);
      } catch {
        h = m[1];
      }
    }
  }
  return h;
}

export default async function run(input) {
  const q = String(input || "").trim();
  if (!q) return "No query provided.";
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const res = await httpGet(url);
    if (!res.ok) return `Search failed: HTTP ${res.status}`;
    const buf = await res.arrayBuffer();
    const html = new TextDecoder("utf-8").decode(buf.slice(0, MAX_BYTES));

    const results = [];
    const blockRe = /<div[^>]*class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g;
    let m;
    while ((m = blockRe.exec(html)) && results.length < 8) {
      const block = m[0];
      const titleM = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      const snippetM = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      if (titleM) {
        results.push({
          title: stripHtml(titleM[2]),
          url: cleanUrl(titleM[1]),
          snippet: snippetM ? stripHtml(snippetM[1]).slice(0, 300) : "",
        });
      }
    }

    if (!results.length) {
      const anyRe = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = anyRe.exec(html)) && results.length < 8) {
        results.push({ title: stripHtml(m[2]), url: cleanUrl(m[1]), snippet: "" });
      }
    }

    return results.length ? JSON.stringify(results, null, 2) : `No results for "${q}".`;
  } catch (err) {
    return `Search failed: ${err.message}`;
  }
}
