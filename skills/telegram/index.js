import { httpPost } from "../_http.js";

const TOKEN = globalThis.process?.env?.TELEGRAM_BOT_TOKEN;
const CHAT_ID = globalThis.process?.env?.TELEGRAM_CHAT_ID;

function needConfig() {
  return JSON.stringify(
    {
      ok: false,
      error: "Telegram not configured.",
      fix: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables (bot from @BotFather, chat id from getUpdates).",
    },
    null,
    2,
  );
}

async function call(method, body) {
  try {
    const res = await httpPost(`https://api.telegram.org/bot${TOKEN}/${method}`, body);
    const json = await res.json();
    if (!json.ok) return JSON.stringify({ ok: false, description: json.description }, null, 2);
    return JSON.stringify({ ok: true, method, result: json.result }, null, 2);
  } catch (err) {
    return `Telegram request failed: ${err.message}`;
  }
}

export default async function run(input) {
  if (!TOKEN || !CHAT_ID) return needConfig();
  const text = String(input || "").trim();
  if (!text) return "No Telegram instruction provided.";

  const mSend = /^send\s*:\s*(.+)/is.exec(text);
  if (mSend) return call("sendMessage", { chat_id: CHAT_ID, text: mSend[1].slice(0, 4000) });

  const mPhoto = /^photo\s*:\s*(\S+)\s*(?:\|\s*(.*))?$/is.exec(text);
  if (mPhoto) {
    const payload = { chat_id: CHAT_ID, photo: mPhoto[1] };
    if (mPhoto[2]) payload.caption = mPhoto[2].slice(0, 1000);
    return call("sendPhoto", payload);
  }

  const mFile = /^send\s+file\s*:\s*(\S+)/i.exec(text);
  if (mFile) return call("sendDocument", { chat_id: CHAT_ID, document: mFile[1] });

  return `Unknown instruction "${text}". Supported: send: <text>, photo: <url> | <caption>, send file: <url>.`;
}
