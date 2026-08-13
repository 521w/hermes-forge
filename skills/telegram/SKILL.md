---
name: telegram
description: Send messages and files through the Telegram Bot API using the configured bot token. Use when the user asks to notify or deliver content via Telegram.
---

# Telegram Skill

Sends text messages (and optionally images/files by URL) to a Telegram chat via the Bot API.

## Configuration

The bot token is read from the environment variable `TELEGRAM_BOT_TOKEN`, and the target chat id from `TELEGRAM_CHAT_ID`. Provide both in `.env` / the process environment for the skill to work.

- Token: obtain from @BotFather when creating the bot.
- Chat id: the numeric id of the user or group; find it by messaging the bot and reading the update via `getUpdates`.

## Usage

Hand the skill an instruction as `input`. Supported:

- `send: <message text>`
- `photo: <image url> | <caption>`
- `send file: <file url>`

## Output

Confirmation JSON from the Telegram API (message id, chat). If the token is missing, returns a clear configuration hint instead of failing silently.

## Notes

- Never print the bot token in outputs — only reference whether it is configured.
- Respect Telegram's privacy policy; only send messages the user asked for.
