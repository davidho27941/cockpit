# cache-keeper

Keeps the prompt cache from lapsing while you are away from the keyboard.

Every request Claude Code sends to the API carries a long prefix: the system prompt, the tool definitions, the whole conversation. That prefix is written to the prompt cache, and later requests that hit it pay a fraction of the price and come back much faster. But the entry lives one hour: an hour after it was last used it is gone, and the next turn has to rewrite the entire context, slowly and at full price.

cache-keeper waits for the session to idle, then every so often (default 50 minutes) sends one line, "reply ok", over the same conversation prefix. The cache gets used once more and its lifetime extends by another hour.

```
♨ cache warm · next in 38m · 3 pokes · last hit 98k tok
```

## Usage

Install it and it runs; nothing to configure. The countdown starts when the first turn ends. It never pokes during a turn, and every real request restarts the countdown from the moment the request went out (the cache lifetime counts from the request's start, not from the end of the reply).

| Command | What it does |
|---|---|
| `/cache-keeper` | Status: interval, time to the next poke, pokes so far, last cache hit size |
| `/cache-keeper now` | Poke immediately (refused while a turn runs, since that turn refreshes the cache itself) |
| `/cache-keeper off` | Pause warming for this session |
| `/cache-keeper on` | Resume |

## Settings

Change them on the `/plugin` settings page or under `pluginConfigs` in `~/.claude/settings.json`:

| Field | Default | Meaning |
|---|---|---|
| `interval_minutes` | `50` | How long the session may idle before a poke. The cache lapses after an hour, so this must be under 60; the mod clamps it to 5–59, leaving ten minutes for clock drift and API latency |
| `max_idle_hours` | `4` | Stop warming once this long has passed since the last real turn. `0` means never stop (see the cost section) |
| `enabled` | `true` | Off means the mod sends nothing at all |
| `show_band` | `true` | Draw the countdown line above the prompt, in its own rounded frame stacked with the other mods' frames |
| `language` | `auto` | UI language: `auto` reads `LC_ALL`, `LC_MESSAGES`, then `LANG` (`zh*` → Traditional Chinese, `ja*` → Japanese, anything else → English); or set `en`, `zh-TW` or `ja` explicitly |
| `band_style` | `box` | How the line is framed: `box` (a rounded frame, dim normally and yellow while backing off after failed pokes), `rule` (a thin line beneath it), `plain` (text only) |

## How it works, and what it costs

**Mechanism.** The mod calls `$.model.fork`, which re-sends the main loop's last request exactly (same model, system prompt, tools and conversation) with one very short user message appended and no tools enabled. Because the prefix is byte-identical, the API serves it from the cache and resets the entry's one-hour timer. The reply's `cache_read_input_tokens` says how much was served; near zero means we were late, the entry had already lapsed, and this request rewrote it.

**What one poke costs.** The whole prefix at cache-read price, plus a few output tokens. The bigger the context, the dearer the poke.

**Price ratios** (Anthropic list prices, the model's base input price = 1):

| Item | Multiplier |
|---|---|
| Cache read (a hit) | 0.1× on most models; 0.05× on Claude Opus 5.5 ($0.20/MTok); 0.025× on Claude Fable 5.1 ($0.25/MTok) |
| Cache write, 5-minute TTL | 1.25× |
| Cache write, 1-hour TTL (what Claude Code uses) | **2×** |

A hit resets the entry's timer at no extra charge, and the lifetime counts from the **start** of that request.

**Worked example.** A 100k-token context, a 50-minute interval, Claude Opus 5.5 (input $4/MTok, cache read $0.20/MTok).

- One poke: 100k × $0.20/MTok ≈ **$0.02**.
- Without warming, coming back after more than an hour: the next turn rewrites all 100k at the 1-hour write price, 100k × $8/MTok ≈ **$0.80**, with a visibly longer time to first token.
- So: **back after about an hour**, one poke saves roughly $0.78. **Back after four hours**, four pokes cost $0.08 and the return saves $0.80, still worth it. **Forgot the session overnight**, $0.02 an hour burns for nothing. That is why `max_idle_hours` exists, and why it stops after four hours by default.
- Other models scale with their ratios: at 0.1× a poke costs a tenth of base input, and a rewrite costs twice base input.

**Worth it when** the context is large (tens of thousands of tokens or more) and you often step away for ten minutes to an hour (reading, a meeting, waiting on CI).
**Not worth it when** the context is small (there is little to save) or you leave for hours at a time (lower `max_idle_hours`, or turn it off).

**Timeline** (50-minute interval, 4-hour cap):

```
turn ends ─50m─▶ poke ─50m─▶ poke ─50m─▶ poke ─50m─▶ poke ─40m─▶ 4h reached, stop
   any new turn pulls this line back to its start
```

**On failure.** An API error (overload, rate limit) backs off: retry after a minute, then two, then four… up to one interval. The first failure shows a toast; later ones only go to the debug log. When there is no reply yet (a new session, or right after `/clear`) there is nothing to warm and the poke is skipped quietly.

## Safety boundary

- Reads and writes no files, runs no commands, opens no network connection. The one outward action is that single model request, through the session's own API client and credentials.
- What goes out is the conversation prefix the session has already sent, plus one fixed line. No new information leaves your machine.
- Only while idle: never during a turn; a running subagent does not affect main's countdown; past the idle cap it stops.
- At most one poke per interval; a manual `/cache-keeper now` runs one at a time and never stacks.
- `claude -p` and SDK sessions have nobody waiting, so they are never warmed.

## What it does before you install it

```bash
claude plugin validate ./plugins/cache-keeper
```

Result (v0.1.0):

```
hooks: session.start, command.run{command=cache-keeper}, turn.start, turn.step, turn.complete,
       session.end, ui.render{component=AbovePrompt}
calls: $.clock.every, $.clock.now, $.command.register, $.env.get (via resolveLanguage),
       $.model.fork (via poke), $.state.get, $.state.set, $.ui.log (via log), $.ui.resolve,
       $.ui.toast (via toast)
env reads: LANG, LC_ALL, LC_MESSAGES
env writes: nothing
state: cache-keeper.state, cache-keeper.tickAt, cache-keeper.lang
```

- `$.model.fork`: the one poke request; the only thing here that costs money
- `turn.step`: read only, to learn that a real request just went out; no chunk or reply is changed
- `$.env.get`: the three locale variables, to pick the UI language
- No `$.fs`, `$.process`, `$.http`

## Limits

- Whether a poke hits is up to the API. Switching models (`/model`), changing the system prompt, or installing a plugin that changes the tool list all change the prefix, so the next poke is a rewrite and the band's "last hit" drops to near zero.
- The interval is checked every 30 seconds, so a poke can land up to 30 seconds late.
- The band is drawn on the terminal and in Claude Desktop's Code tab only; the warming itself runs in any interactive session.
- Timing state lives in the session's `$.state`: `/clear` resets it, a hot reload keeps it, closing Claude Code drops it, and a fresh session counts from its first turn.

## Development

```bash
claude --plugin-dir ./plugins/cache-keeper   # load once
claude plugin test ./plugins/cache-keeper     # run the tests (27, including the timeline, backoff and languages)
```

`tsconfig.json` depends on `.claude-plugin/types/`, the type declarations Claude Code writes when it loads the mod; they are not committed. UI strings live in `hooks/i18n.ts`, one dictionary per language, and a test checks that every language has every message.
