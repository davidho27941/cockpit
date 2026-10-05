# auto-handover

When context usage reaches a threshold you set, write a handover note first, then compact automatically, and hand the note to whoever continues: this conversation after compaction, and the next session in the same project.

Claude Code's own auto-compact acts close to the limit, and what the summary keeps is up to it. This mod lets you lower the threshold and, before compacting, asks the model to write a handover note with fixed headings over the whole conversation. The note is saved to disk, handed to the summarizer as instructions, and appended back into the conversation once compaction is done.

```
⟲ context 72% / threshold 75% · last handover 12m ago · ~/.claude/handovers/Users-me-code-shop/latest.md
```

The line sits in its own rounded frame, stacked with the other mods' frames above the prompt (`band_style`). While a handover runs, the line and its frame turn yellow:

```
⟲ Handing over: asking the model for a note…
⟲ Handing over: note written, compacting…
```

When it is done, a toast: `⟲ Handed over and compacted: 76% → 21%, note ~/.claude/handovers/Users-me-code-shop/latest.md`

## Usage

It works as soon as it is installed. To change the threshold, folder or language, use the settings page under `/plugin`.

| Command | What it does |
|---|---|
| `/handover` | Status: threshold, current usage, whether the next turn will hand over, when and where the last handover was |
| `/handover now` | Hands over and compacts about 1.5 s later, ignoring the threshold and cooldown (waits for a running turn to end) |
| `/handover show` | Prints the latest handover note |
| `/handover off` / `on` | Pauses or resumes automatic handovers; `/handover now` still works while paused |

### When it acts

1. Every usage reading (`session.measure`) is checked against the threshold.
2. Once over it, the mod arms, but **acts only between turns**: a running turn is never interrupted; 1.5 s after the turn ends it starts.
3. Write the note → save it → compact (the note goes to the summarizer as instructions) → append the note to the conversation as a message the model reads and you do not see → toast.
4. A cooldown follows (default 10 minutes), so a still-high reading right after compaction does not trigger again.

Manual `/compact` and the engine's own auto-compact also pass through this mod: a note is written first, merged into the summary instructions, and appended afterwards. Whoever starts the compaction, a readable handover remains.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `threshold` | `75` | Trigger threshold (%). Clamped to 40..95 |
| `handover_dir` | `~/.claude/handovers` | Notes folder; must be `~/…` or an absolute path under your home directory, otherwise the mod disables itself and says why in the band |
| `cooldown_minutes` | `10` | Minimum gap between two automatic handovers |
| `resume_hours` | `24` | A new session in the same project gets `latest.md` as opening context when it is younger than this; `0` disables it |
| `inject_after_compact` | `true` | Append the note to the conversation after compaction |
| `language` | `auto` | Language of the UI and of the note: `auto` reads `LC_ALL`, then `LC_MESSAGES`, then `LANG` (`zh*` → Traditional Chinese, `ja*` → Japanese, anything else → English); or `en`, `zh-TW`, `ja` |
| `band_style` | `box` | How the band line is framed: `box` (its own rounded frame, dim normally and yellow while a handover runs or something is wrong), `rule` (a thin line beneath it), `plain` (text only) |

The language applies to the band, toasts, `/handover` output, the note's headings, the prompt that asks for the note, the compaction instructions and the framing of the appended and resumed notes. The note's body is written in the language the conversation itself uses.

## The handover note

### Where it goes

```
<handover_dir>/<project root path with / replaced by ->/
  2026-10-04T13-05-22Z.md   ← one per handover
  latest.md                 ← always the newest
```

For a project at `/Users/me/code/shop` the notes are in `~/.claude/handovers/Users-me-code-shop/`.

### Format

```markdown
---
project: /Users/me/code/shop
session: 2f1c…
time: 2026-10-04T13:05:22.000Z
context_percent: 76
model: claude-…
trigger: threshold        ← threshold | command | manual | auto
language: en
written_by: auto-handover
---

# Handover note
## Goal
## Current state
## Done
## In progress
## To do (by priority)
## Key decisions and why
## Important files and locations
## Caveats / pitfalls
## Next step (first thing)
```

The headings are fixed (in the chosen language); the model writes "none" under an empty one. About 600 words at most, body in the conversation's language. The front block keys stay English so other tools can read them.

### Who gets it

- **This conversation after compaction**: the full note is merged into the summarizer's instructions (keep goal, to-do, decisions, files and next step verbatim), and after compaction it is appended as a meta message the model continues from.
- **The next session**: a new session in the same project gets `latest.md` as an opening context block (named `handover`) when it is younger than `resume_hours`, framed as left by the previous session. A session that handed over itself does not get it again.

## Safety boundary

- Writes only under `handover_dir`; the folder must be under your home directory and contain no `..`. An invalid value disables the mod and shows why; there is no fallback folder. An unknown home directory (`HOME` unset) disables it too.
- Reads only `latest.md` in that folder (for a new session); files over 256 KB are not read.
- No network, no shell, no other sessions touched.
- Two kinds of model calls only: `$.model.fork` to write the note, and compaction's own summary request.

## What it does before you install it

```bash
claude plugin validate ./plugins/auto-handover
```

Result (v0.1.0):

```
hooks: session.start, session.measure, turn.start, turn.complete, session.compact,
       prompt.context, session.end, command.run{command=handover},
       ui.render{component=AbovePrompt}
calls: $.clock.after, $.clock.now, $.command.register, $.env.get, $.fs.read, $.fs.stat,
       $.fs.write, $.model.fork, $.session.append, $.session.compact, $.session.id,
       $.session.model, $.session.root, $.session.usage, $.state.get, $.state.set,
       $.ui.invalidate, $.ui.log, $.ui.resolve, $.ui.toast
env reads: HOME, LANG, LC_ALL, LC_MESSAGES
env writes: nothing
```

- `$.model.fork`: writes the handover note, once per handover
- `$.session.compact`: compacts when the threshold is reached
- `$.session.append`: appends the note to the compacted conversation
- `$.fs.write`: only the two files under `handover_dir`; `$.fs.read` / `$.fs.stat`: only `latest.md` in the same folder
- `$.env.get`: `HOME` for the folder, `LC_ALL` / `LC_MESSAGES` / `LANG` for the language

## Cost

The note is written with `$.model.fork`: the request is appended to the current conversation, so the whole conversation prefix is served from the prompt cache. One handover costs roughly:

- a cache read of the whole conversation (about a tenth of the regular input price on a hit),
- plus the note itself (about 600 words of output),
- plus the summary request compaction makes anyway.

When the cache has lapsed (an idle hour, a model change) the prefix is billed once more. The debug log (`claude --debug`) records `cache_read_input_tokens` for every note.

## Limits

- Acts only between turns; a very long turn is not compacted midway (the engine's own auto-compact still takes over at its threshold, and that one gets a note too).
- `claude -p` and SDK sessions never hand over automatically (nobody watches the band, and the mod should not decide when they compact); the `session.compact` hook path still writes a note.
- A failed note (API error, empty reply) shows a toast and starts one cooldown; it never blocks compaction, which the engine does as usual.
- The usage percentage is the engine's own reading (the status line's number), updated after each model response.

## Development

```bash
claude --plugin-dir ./plugins/auto-handover   # load once
claude plugin test ./plugins/auto-handover     # run the tests
```

`tsconfig.json` relies on `.claude-plugin/types/`, which Claude Code writes when it loads the mod; it is not committed.

The test kit has no implementation of `session.append`, so the plugin's `$.session.append` gets `no implementation` under test; the tests count injection attempts from the debug log, and only a real session appends the note.
