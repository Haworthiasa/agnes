# Agnes bot

An always-on personal agent on Telegram, built on the pi SDK. It aims at the same product space as OpenAI dots, Hermes Agent and the Grok bot: one agent that remembers you, searches the web, and works on a schedule without being asked.

Private package. It is not published.

## Run

1. Give the bot a model. Either run `pi` once and `/login` (the bot shares `~/.pi/agent/auth.json`), or export a provider key, for example `ZAI_API_KEY` for GLM.
2. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
3. Get your numeric user id, for example from [@userinfobot](https://t.me/userinfobot).
4. Start the bot from this directory:

```bash
TELEGRAM_BOT_TOKEN=123:abc BOT_ALLOWED_USERS=111111111 npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | Bot API token |
| `BOT_ALLOWED_USERS` | required | Comma-separated Telegram user ids. Everyone else is ignored. |
| `BOT_MODEL` | pi default model, else first with credentials | `provider/model-id`, for example `zai/glm-5.3-flash` |
| `BOT_DATA_DIR` | `~/.agnes-bot` | Sessions, memory, jobs and the agent workspace |
| `BOT_TZ` | `Asia/Ho_Chi_Minh` | Time zone for schedules and the current-time line |
| `BOT_ALLOW_SHELL` | off | `1` enables pi's file and shell tools (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`) |

With GLM:

```bash
ZAI_API_KEY=... BOT_MODEL=zai/glm-5.3-flash TELEGRAM_BOT_TOKEN=123:abc BOT_ALLOWED_USERS=111111111 npm start
```

Security: pi's file tools accept absolute paths, so they are not confined to the workspace. The bot also reads untrusted web pages. With `BOT_ALLOW_SHELL=1`, an injected page could make the bot read local secrets and send them out with `web_fetch`. Enable it only on an isolated machine or container.

Chat commands: `/new` starts a fresh conversation. `/help` lists commands.

## How it works

```
Telegram ──long poll──▶ Gateway ──per chat, in order──▶ pi AgentSession ──▶ tools
   ▲                       │                                 │              web_search / web_fetch
   └──────── sendMessage ◀─┴──────── Scheduler (jobs.json) ◀─┘              memory / schedule
```

- **Sessions.** Each chat has one persistent pi session under `chats/<chatId>/sessions`. A restart continues it.
- **Memory.** `chats/<chatId>/memory/USER.md` and `MEMORY.md` hold bounded entries (1400 and 2200 chars). The system prompt is rebuilt before every turn, so a saved fact is visible in the next turn.
- **Web.** No API keys. Tries Parallel MCP, then Exa MCP (free tiers), then DuckDuckGo lite with direct page fetches. A rate-limited backend falls through to the next one.
- **Schedules.** Every N minutes, daily at HH:MM, or once. Each run uses a fresh in-memory session and posts the result to the chat. Restarts neither repeat nor replay a run.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Telegram gateway, persistent sessions, allowlist, keyless web, bounded memory, scheduler | done |
| 2 | Search across past sessions, voice notes, images, typing while a turn runs, `/model` and `/jobs` commands | next |
| 3 | Standing goals in the style of dots: the agent plans and checks in on long-running objectives | planned |
| 4 | Self-written skills (Hermes procedural memory), sandboxed shell and headless browser, Discord and Slack | planned |

## Test

```bash
node ../../node_modules/vitest/dist/cli.js --run
```

Tests use the pi faux provider and a fake transport. They make no network or model calls.
