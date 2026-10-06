# Agnes bot

An always-on personal agent on Telegram, built on the pi SDK. It aims at the same product space as OpenAI dots, Hermes Agent and the Grok bot: one agent that remembers you, searches the web, and works on a schedule without being asked.

Private package. It is not published.

## Run

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Get your numeric user id, for example from [@userinfobot](https://t.me/userinfobot).
3. Start the bot from this directory, in a terminal:

```bash
npm start
```

The first run asks for the bot token, the allowed user ids and the model (`provider/model-id`, for example `zai/glm-5.3-flash`). When the model's provider has no credentials yet, it also asks for an API key. Later runs start without questions.

- The token, user ids and model go to `<BOT_DATA_DIR>/config.json`, readable by the owner only (mode 600).
- The API key goes to pi's `~/.pi/agent/auth.json`, shared with the pi CLI. Providers that need a subscription sign-in (OAuth) are set up with `pi` and `/login` instead.
- Setup refuses a `BOT_DATA_DIR` inside a git repository, so the token cannot be committed.
- `npm start -- --setup` asks every question again.
- Without a terminal (systemd, nohup), the bot does not ask. It needs a saved config or the variables below.

Environment variables override the saved config for one run and do not rewrite it.

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | saved config | Bot API token |
| `BOT_ALLOWED_USERS` | saved config | Comma-separated Telegram user ids. Everyone else is ignored. |
| `BOT_MODEL` | saved config, else pi default model, else first with credentials | `provider/model-id`, for example `zai/glm-5.3-flash` |
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
- **Web.** No API keys. `web_search` takes an objective (what to find, how fresh, which sources count) plus 1-3 queries, and tries Parallel MCP, then Exa MCP, then DuckDuckGo lite; when every backend is rate limited it waits 2 s and tries once more. `web_fetch` tries Parallel, then a direct HTTP fetch, then Exa, per URL, and cuts a long page to its opening plus the parts that match the objective. A reply never shows a URL that no tool result, user message or memory contained.
- **Web quality.** `node --import ../coding-agent/src/experimental/source-resolver.ts scripts/web-eval.ts` scores retrieval against `scripts/web-eval.questions.json` without a model; `--e2e` scores the real bot's replies through the verify-agnes skill.
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
