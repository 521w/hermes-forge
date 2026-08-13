import { httpGet, b64ToUtf8 } from "../_http.js";

const API = "https://api.github.com";

async function gh(path, accept = "application/vnd.github+json") {
  const headers = { Accept: accept };
  const token = globalThis.process?.env?.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await httpGet(`${API}${path}`, headers);
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        const limit = res.headers?.["x-ratelimit-reset"];
        return `GitHub API rate limited (HTTP ${res.status}).${limit ? ` Resets at epoch ${limit}.` : ""} Set GITHUB_TOKEN for a higher limit.`;
      }
      return `GitHub API error: HTTP ${res.status}`;
    }
    return res.json();
  } catch (err) {
    return `GitHub request failed: ${err.message}`;
  }
}

function repoSummary(r) {
  return {
    full_name: r.full_name,
    description: (r.description || "").slice(0, 200),
    url: r.html_url,
    language: r.language,
    stars: r.stargazers_count,
    forks: r.forks_count,
    updated: r.updated_at,
    topics: (r.topics || []).slice(0, 8),
  };
}

export default async function run(input) {
  const text = String(input || "").trim();
  if (!text) return "No GitHub instruction provided.";

  const mRepo = /^repo:\s*([\w.-]+\/[\w.-]+)/i.exec(text);
  if (mRepo) {
    const r = await gh(`/repos/${mRepo[1]}`);
    return typeof r === "string" ? r : JSON.stringify(repoSummary(r), null, 2);
  }

  const mReadme = /^readme:\s*([\w.-]+\/[\w.-]+)/i.exec(text);
  if (mReadme) {
    const readme = await gh(`/repos/${mReadme[1]}/readme`);
    if (typeof readme === "string") return readme;
    if (readme.encoding === "base64" && readme.content) {
      return b64ToUtf8(readme.content).slice(0, 4000);
    }
    return `No README available for ${mReadme[1]}.`;
  }

  const mCode = /^search code:\s*(.+)/i.exec(text);
  if (mCode) {
    const items = await gh(`/search/code?q=${encodeURIComponent(mCode[1])}&per_page=5`);
    if (typeof items === "string") return items;
    const list = (items.items || []).map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url }));
    return list.length ? JSON.stringify(list, null, 2) : `No code results for "${mCode[1]}".`;
  }

  const mUsers = /^search users:\s*(.+)/i.exec(text);
  if (mUsers) {
    const items = await gh(`/search/users?q=${encodeURIComponent(mUsers[1])}&per_page=5`);
    if (typeof items === "string") return items;
    const list = (items.items || []).map((u) => ({ login: u.login, type: u.type, url: u.html_url }));
    return list.length ? JSON.stringify(list, null, 2) : `No user results for "${mUsers[1]}".`;
  }

  const mSearch = /^search repos?:\s*(.+)/i.exec(text);
  if (mSearch) {
    const items = await gh(`/search/repositories?q=${encodeURIComponent(mSearch[1])}&per_page=5&sort=stars`);
    if (typeof items === "string") return items;
    const list = (items.items || []).map(repoSummary);
    return list.length ? JSON.stringify(list, null, 2) : `No repo results for "${mSearch[1]}".`;
  }

  return `Unknown instruction "${text}". Supported: search repos/users/code: <q>, repo: <owner>/<name>, readme: <owner>/<name>.`;
}
