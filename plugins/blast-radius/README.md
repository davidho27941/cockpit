# blast-radius

Holds a risky shell command before Claude runs it, works out what it would change, and opens a pane with **Proceed** and **Cancel**. Cancel refuses the command and tells Claude why, so it knows nothing ran.

This mod comes from Anthropic's [claude-code-playground](https://github.com/anthropics/claude-code-playground) (`claude-code/mods/blast-radius`), Apache-2.0. The copy here adds a `language` option (English, Traditional Chinese, Japanese) and leaves the logic untouched; see *Origin and license* below. The upstream README, with screenshots and the story of how it was built, is kept as [README.upstream.md](README.upstream.md).

```
╭─ ⚠ Blast Radius · rm -rf ─────────────────────────────────────╮
│ Command  rm -rf build                                         │
│ Would    delete 128 files (about 4.2 MB)                      │
│                                                               │
│   build/index.js                                              │
│   build/assets/app.css                                        │
│   + 126 more                                                  │
│ Paths: build                                                  │
│                                                               │
│ 1: Proceed   2: Cancel   Claude is waiting on your answer     │
╰───────────────────────────────────────────────────────────────╯
```

## What it holds, and what the pane shows

| Command | The pane shows |
|---|---|
| `rm -r`, `rm -f`, `rm -rf` | The files it would delete: count, total size, the first 10 paths. Globs and `~` are expanded. |
| `git reset --hard` | The files with uncommitted changes (`git status --porcelain`) and `git diff --shortstat`. |
| `git checkout -- .`, `git restore .` | The files with unstaged changes. |
| `git clean` | The untracked paths it would remove, from `git clean -n` with the same flags. |
| `git push --force` (also `-f`, `--force-with-lease`, `+ref`) | The commits on the remote branch that your HEAD does not have, which the push would drop. |
| `manage.py migrate`, `db:migrate`, `alembic upgrade`, `prisma migrate` | The pending migrations, from the tool's own status command. |
| any other `migrate` | A note that it cannot list the pending migrations for that tool. |

Every other command runs as normal. If the command line moves first, with `cd dir &&`, `pushd`/`popd` or `git -C dir`, the measurement runs in that folder. A `cd` inside `( ... )` only applies inside the parentheses, as in the shell.

## Usage

It works as soon as it is installed. No commands.

- When the pane appears, press `1` for Proceed or `2` for Cancel. **Prefer the digits.**
- Arrow keys, Tab and Enter only work while the pane actually holds the keyboard. The pane *requests* focus when it opens, and Claude Code grants it only over an empty composer. If the composer has text, or the terminal is too narrow and the report is drawn in the band above the prompt instead, the keys stay with the composer. An Enter there is read by Claude Code as "background this turn once the current tool finishes": the session is continued under a new session id and the transcript shows `Backgrounding after the current tool finishes…`. To use the arrows, click the pane first, or press `ctrl+x` then `tab` to hand it the keyboard.
- Cancel has the focus when the pane does hold the keyboard, so Enter there refuses the command.
- No answer within 10 minutes refuses the command. Interrupting the turn (Esc) refuses it too.
- One command is held at a time. A second risky call (from a subagent, say) waits until the first is answered.

## Settings

| Option | Default | Meaning |
|---|---|---|
| `language` | `auto` | Language of the pane, the toast and the refusal text: `auto` (from `LC_ALL`, then `LC_MESSAGES`, then `LANG`: `zh*` gives Traditional Chinese, `ja*` Japanese, anything else English), `en`, `zh-TW` or `ja`. |

Set it with `/plugin configure blast-radius@cockpit`, or `--config language=ja` at install. Command names in the pane (`rm -rf`, `git reset --hard`, …) are never translated. Every refusal ends with the same English line, `(blast-radius: the user did not approve this command; do not retry unless asked.)`, so Claude reads a Japanese or Chinese refusal as a refusal, not as a transient error.

## Beside the other mods in this repo

- While it holds a command it takes over the band above the prompt (its `AbovePrompt` hook does not pass the band on). The lines of opsx-board, auto-handover and cache-keeper disappear for that time and return once you answer. That is deliberate: the buttons must be on top.
- It only watches the Bash tool. opsx-board's checkbox edits and auto-handover's note files go through the mod file API, not Bash, so they are never held.

## Safety boundary

- It reads the command text; it is not a full shell parser. `$(...)`, aliases, `eval`, `bash -c "..."`, `xargs rm`, `find -delete`, scripts that call `rm`, and wrappers such as `timeout 5 rm` or `doas rm` are not caught.
- Paths are passed to `bash`, `find`, `du` and `git` as arguments, never as shell source; a relative path gets `./` in front so `find` never reads a file named like `-delete` as an action.
- Listing migrations runs the tool's own status command (for example `python3 manage.py showmigrations`), which loads your project's code before you choose.
- It is a safety net, not a permission system. After Proceed the command runs as written, with no sandbox. For a hard block use [permission rules](https://code.claude.com/docs/en/settings).

## What it does, before you install it

```bash
claude plugin validate ./plugins/blast-radius
```

Result (this copy, on Claude Code 2.1.289):

```
hooks: session.start, tool.call{tool=Bash}, ui.render{component=Pane}, ui.render{component=AbovePrompt}
calls: $.clock.now, $.env.get, $.process.run, $.session.cwd, $.ui.close, $.ui.invalidate,
       $.ui.open, $.ui.resolve, $.ui.toast
env reads: LANG, LC_ALL, LC_MESSAGES
env writes: nothing
```

`$.process.run` is used for measuring (`bash -c` to expand paths, `find`, `du -k`, `git status/diff/clean -n/log/rev-parse`, the migration tool's status command) and for the hold loop, which waits on `sleep 0.25` until a button is pressed. `$.env.get` reads the three locale variables once, at session start. No file reads or writes, no network, no model calls.

## Requirements and limits

- `bash`, `git`, `find` and `du` on your `PATH`; for migrations, the project's own tool.
- Only the first risky part of a command line is measured, and the pane shows the command on one line, cut off if long. Proceed runs the whole line as written.
- `cd -` and a folder that does not exist cannot be measured; the pane says so and still holds the command.
- The `rm` count is approximate: a path matched twice is counted twice, a file name with a line break is not counted, and sizes come from `du -k` (space on disk). A very large tree can take a few seconds.
- The force-push list uses your last fetch of the remote branch. Without one it cannot list the dropped commits, and says so. With no remote named, it assumes `origin`.
- A few harmless commands are held too, such as a commit whose message contains `; rm -rf`, or a heredoc that writes a file containing that text.
- A terminal narrower than about 144 columns gets the report in the band above the prompt instead of a side pane.

## Origin and license

- Upstream: [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground), `claude-code/mods/blast-radius`, commit `569c5283` (2026-10-01), by Claude Code DevRel. Copyright 2026 Anthropic PBC.
- License: Apache License 2.0, full text in [LICENSE](LICENSE) in this folder. The other mods in this repo are MIT; the two do not affect each other.
- Modifications: the user-facing strings moved into `hooks/i18n.mjs` and a `language` option was added; classification, measuring and holding logic are unchanged. The exact list is in [NOTICE](NOTICE) and in the header of `hooks/blast-radius.mjs`. `hooks/hooks.json`, `screenshots/` and `README.upstream.md` are the upstream files byte for byte.
- Upstream's note applies: shared as-is as part of claude-code-playground, not an official Anthropic product, no support or maintenance implied.

## Development

```bash
claude plugin validate --strict ./plugins/blast-radius
claude plugin test ./plugins/blast-radius     # resolveLang, the dictionaries, classify
claude --plugin-dir ./plugins/blast-radius    # load it for one session
```

Upstream ships no tests (its README mentions tests run in an internal workspace). The tests here cover the language pick, the completeness of the three dictionaries and the command classifier; the measuring step and the hold are exercised in a live session only. If you change the code, add the change to `NOTICE`, as Apache-2.0 requires.

One trap while developing: a Bash command whose *text* contains `rm -rf` (a heredoc writing a test file, a `grep` for it) is itself held by the installed mod. Build such strings from pieces, or write the file with a tool other than Bash.
