# secret-guard

Keeps API keys, cloud credentials and other secrets out of what is sent to the model. Every text that enters the conversation is scanned for known secret shapes; each match is replaced with a meaningful placeholder, a toast says what was redacted, and the band keeps a count. The value itself is never logged, stored or shown.

Before (what Claude would have read):

```
$ cat .env
GOOGLE_API_KEY=AIzaSyA-fake-key-for-the-readme-0000000
DATABASE_URL=postgres://app:hunter2hunter2@db.internal:5432/app
```

After (what Claude reads):

```
$ cat .env
GOOGLE_API_KEY=<google api key>
DATABASE_URL=postgres://app:<password>@db.internal:5432/app
```

```
🛡 secret-guard · 2 redacted this session · last: password (tool result)
```

## Where it hooks, and why

| Hook | What passes through it |
|---|---|
| `session.append` | Every row a conversation keeps, before it is stored: your prompt, a slash command's output, **every tool result** (file contents, command output, web pages), delivered messages, injected notes, compaction summaries. The main conversation and **every subagent's** alike. The engine stores what the chain answers, so the model's next request carries the redacted row. The model's own response blocks and notices it never reads are left alone. |
| `prompt.submit` | Your message, so it is shown and stored redacted. |
| `prompt.context` | The context blocks the first message carries (CLAUDE.md and friends). |
| `prompt.attachment` | Texts the engine injects on its own: a mentioned file, a reminder, a settings hook's output. |

`session.append` is the choke point: it is the one place through which a tool result or a subagent's row reaches the model, which is why a `Read` of a key file or a `cat .env` in a sub agent is covered without hooking each tool.

## What it detects

| Placeholder | Matches |
|---|---|
| `<gcp service account private key>`, `<gcp service account private key id>` | the two key fields of a `"type": "service_account"` JSON file; `client_email` and `project_id` stay readable |
| `<private key>` | any PEM private key block (RSA, EC, DSA, OPENSSH, PGP, encrypted; real or `\n`-escaped newlines); certificates are not secrets |
| `<google api key>` | `AIza…` (39 characters) |
| `<google oauth access token>`, `<google oauth refresh token>`, `<google oauth client secret>` | `ya29.…`, `1//0…`, `GOCSPX-…` |
| `<aws access key id>` | `AKIA…`, `ASIA…`, `ABIA…`, `ACCA…`, `A3T…` (20 characters) |
| `<aws secret access key>` | a 40-character value next to `aws_secret_access_key` / `secretAccessKey` |
| `<anthropic api key>`, `<openai api key>` | `sk-ant-…`, `sk-…` / `sk-proj-…` |
| `<github token>`, `<gitlab token>` | `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`, `github_pat_…`, `glpat-…` |
| `<npm token>`, `<pypi token>`, `<hugging face token>` | `npm_…`, `pypi-AgEIcHlwaS5vcmc…`, `hf_…` |
| `<slack token>`, `<slack webhook url>` | `xox[abposre]-…`, `https://hooks.slack.com/services/T…/B…/…` |
| `<telegram bot token>`, `<discord bot token>` | `123456789:AA…`, the three-part Discord shape |
| `<stripe secret key>`, `<sendgrid api key>`, `<twilio api key>` | `sk_live_` / `sk_test_` / `rk_…`, `SG.….…`, `SK` + 32 hex |
| `<jwt>` | `eyJ….eyJ….…` |
| `<bearer token>`, `<basic auth>`, `<token>` | the value after `Authorization: Bearer|Basic|Token` |
| `<api key>` | the value after `x-api-key:` / `api-key:` / `apikey:` |
| `<password>` | the password in `scheme://user:password@host` |
| `<secret value>` | the value of `api_key = …`, `password: …`, `"client_secret": "…"`, `export TOKEN=…` and the like (names: api key, secret key, client secret, access / auth / refresh token, private key, password, passwd, pwd, token, secret), 8+ characters, when it does not look like a placeholder, an environment reference, code, a path or a URL |
| `<high-entropy secret>` | a random-looking token of 32+ characters with Shannon entropy ≥ 4.0 bits/char that sits within 60 characters after a secret-ish word (key, secret, token, password, credential, auth, signature, bearer, …); hex hashes, UUIDs and base64 data URIs are excluded |

Detectors run in that order, specific before generic, and `redact()` is idempotent: a placeholder never matches a detector, so a row that is scanned twice (the prompt passes `prompt.submit` and then `session.append`) is rewritten once.

Placeholders are English in every UI language: the model reads them and they must be stable. With `keep_hint` on, the last four characters ride along (`<google api key …Zx3f>`) so two keys can be told apart; off by default.

## Usage

Installed, it is on. The band above the prompt appears once something has been redacted: one line in its own rounded frame, stacked with the other mods' frames; the frame turns yellow while the mod is paused or a custom pattern did not compile (`band_style`).

| Command | Does |
|---|---|
| `/secret-guard` | status: enabled / paused, what is scanned, totals by label, and the last 20 hits, one per line (see below) |
| `/secret-guard log` | every hit recorded this session (up to 100), grouped by fingerprint: the same secret seen in several places is one group |
| `/secret-guard clear` | forgets the hit list and the counters of this session |
| `/secret-guard off` / `on` | pause / resume for this session (the `enabled` setting is the permanent switch) |
| `/secret-guard test` | runs every detector over a built-in sample of obviously fake values and prints which labels fired; a self-test, no real secrets involved |

## The hit record

Each redaction is recorded for this session, to help you find where secrets live and whether the same one turns up in several places. Nothing is kept past the session, nothing is written to disk, and the value itself is never stored, shown or logged.

```
14:02  aws secret access key  #a3f91c02  Read ~/proj/.env:4
14:02  github token           #77be1d40  Read ~/proj/.env:6
14:05  aws secret access key  #a3f91c02  Bash cat ~/proj/.env:2 [agent 3fa9c1d2]
14:07  google api key         #0b5e7a91  prompt
```

| Field | What it is |
|---|---|
| time | when the row passed |
| label | the placeholder's label |
| fingerprint | `#` + the first 8 hex digits of HMAC-SHA256 over the value, keyed with 32 random bytes made when the session starts (kept in the session's `$.state` so a hot reload keeps fingerprints stable, never in `$.store`). The same value gets the same fingerprint within the session; a different session has a different key, so fingerprints cannot be compared across sessions, and without the key a short password cannot be brute-forced from its fingerprint. Off with `fingerprints = false`. |
| tool and source | for a tool result: the tool and what the call was about, a file path for tools that name one (`Read`, `Edit`, `Grep` with a path, `NotebookEdit`), else the Bash command or the Grep pattern. A `tool.call` hook remembers this per `tool_use_id` and passes the call through untouched; the source is itself redacted and cut to 120 characters, and it is never the tool's output. For your prompt it says `prompt`; for context it names the block (`claudeMd`); for an attachment its type |
| line | the line of the match in the scanned text: `Read`'s own line numbers when the output carries them, otherwise counted from the start of that text (for Bash, a line of the output, not of a file) |
| agent | the subagent whose conversation carried it, when it was not the main one |

The toast names the source too: `secret-guard: redacted 2 (aws secret access key, github token) in tool result · Read .env`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `language` | `auto` | UI language: `auto` (from `LC_ALL` / `LC_MESSAGES` / `LANG`), `en`, `zh-TW`, `ja` |
| `enabled` | `true` | Off: nothing is scanned or rewritten |
| `keep_hint` | `false` | Keep the last 4 characters in the placeholder |
| `entropy_backstop` | `true` | The high-entropy detector |
| `custom_patterns` | empty | Extra detectors, one per line as `label=regex` (JavaScript regex; `/…/i` form accepted; `g` is added). An invalid line is shown once in the band and in the status, and ignored. |
| `allow_patterns` | empty | One regex per line; a match that also matches one of these is left alone. The AWS documentation example pair (`AKIAIOSFODNN7EXAMPLE` and its secret) is always allowed. |
| `scan_tool_results` | `true` | Off: only your prompts, slash-command rows and the context blocks are scanned; tool results, attachments, deliveries, notes and compaction summaries pass through |
| `fingerprints` | `true` | Record a per-session HMAC fingerprint of each redacted value (see "The hit record"); off records the hit without one |
| `band_style` | `box` | How the band line is framed: `box` (a rounded frame, dim normally and yellow while paused or with an invalid custom pattern), `rule` (a thin line beneath it), `plain` (text only) |

Set them with `/plugin configure secret-guard@cockpit`.

## What it does not cover

- **Text already in the context before the mod loaded**, and anything the model read in earlier turns.
- **The screen and the transcript's structured record.** The terminal may draw a tool result just before its rewrite, and a tool's structured record (`toolUseResult`) is stored as the tool made it: the transcript file on disk can still hold the raw value even though the model never reads it. Treat transcript files as sensitive regardless.
- **Model output.** If the model reproduces a secret it already knows, that is not scanned.
- **Images and documents**, secrets split across lines or obfuscated (base64-wrapped, reversed, in a screenshot), and shapes the table does not know.
- The `prompt.context` rewrite makes the engine forget which files were behind the `claudeMd` block (its documented rule for a rewritten text); only the files list is affected, the text is still sent.

This is a safety net, not data-loss prevention. Keep secrets out of the repository and the shell history, use a secret manager, and rotate anything that was pasted by mistake.

## False positives and how to allowlist

The generic `<secret value>` rule is the one most likely to fire on something harmless, such as a password-shaped test fixture. Add a regex to `allow_patterns` that matches the fixture, or turn the value into an obvious placeholder (`<your-password>`, `${PASSWORD}`, `xxx`), which the rule skips. Hex hashes, UUIDs, git SHAs, package integrity hashes and ordinary base64 blobs are excluded from the entropy backstop; if it still fires on something, `entropy_backstop` turns it off without losing the specific detectors.

## What it does before you install it

```bash
claude plugin validate ./plugins/secret-guard
```

Result (v0.1.0, Claude Code 2.1.289):

```
hooks: session.start, prompt.submit, tool.call, session.append, prompt.context, prompt.attachment,
       command.run{command=secret-guard}, ui.render{component=AbovePrompt}
calls: $.clock.now, $.command.register, $.env.get, $.state.get, $.state.set, $.ui.resolve, $.ui.toast
env reads: HOME, LANG, LC_ALL, LC_MESSAGES · env writes: nothing
```

No `$.fs`, no `$.process`, no `$.http`, no model calls: the mod reads nothing but the rows that pass through it and writes nothing but their rewrite. The `tool.call` hook only notes what each call is about and passes it on unchanged. What it keeps in `$.state` is counts, labels, where a redaction happened, fingerprints and the session's fingerprint key, never a value; the same goes for toasts and the debug log. `HOME` is read only to shorten paths to `~` in the list.

## Limits

- Detection is by shape. A secret in an unusual format, cut across two lines, or encoded is not seen.
- Everything runs on every row the model reads, in the main conversation and in subagents; the regexes are linear and the cost is negligible next to a model request, but a very large tool result (megabytes) is scanned in full.
- The band is one line; the status command has the detail.
- The hit list holds the newest 100 hits; `/secret-guard clear` empties it.
- A path written near a word like `secret` is not taken for a secret: the entropy backstop skips rooted tokens with three or more `/`, and relative ones with three or more `/` whose segments are all lowercase words (`plugins/secret-guard/hooks/logic.ts`). A base64 secret that happens to start with `/` and contain three `/` would be missed by that one detector.
- Only text blocks and `tool_result` blocks are rewritten. Thinking, tool_use, image and document blocks are pinned by the engine or carry no text.

## Development

```bash
claude plugin validate ./plugins/secret-guard
claude plugin test ./plugins/secret-guard
```

The tests build every fixture from pieces (`'AIza' + 'A'.repeat(35)`) so the test file itself never contains a credential-shaped literal. The `session.append` decision is the pure `planAppend()` in `hooks/logic.ts`, because the test kit cannot raise that event itself; the hook in `hooks/register.tsx` only adds the state and toast calls around it.
