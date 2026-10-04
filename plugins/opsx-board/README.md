# opsx-board

A board for [OpenSpec](https://github.com/Fission-AI/openspec) spec-driven development in Claude Code. Three things in one pane, one band line and the status line:

1. **Which phase you are in**: type `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, … and the band shows the phase and the change name.
2. **Which task of tasks.md is current**: tracks `openspec/changes/<change>/tasks.md` and shows the current task, the next few and a progress bar. The model gets a `task` tool to report each task; on `done` the mod ticks `[x]` itself, so progress never waits for a batch edit at the end.
3. **What every sub agent is doing**: name, type, model/effort, tokens, model requests, tool calls, last action and elapsed time, grouped into running / waiting / done.

```
⧉ opsx apply add-auth · 3.2 Implement token refresh · 5/9 · ⚇ 2 agents running · 1 done · 86k tok · 3s ago
```

`/opsx-board` opens the pane:

```
OpenSpec · apply · add-auth  ▓▓▓▓▓▓░░░░ 5/9
▶ 3.2 Implement token refresh
  ○ 3.3 Refresh token rotation and…   ○ 3.4 Add unit tests   ○ 3.5 Docs and examples
Sub agents · 5 this session · 86k tok total
running (2)
▶ Search auth-related code · Explore · sonnet/medium · 12k tok · running 42s
    step 4 · 7 tools · last Grep "refreshToken" · ↑11k ↓1.2k
▶ Write unit tests · general-purpose · opus/high · 31k tok · running 12s
    step 2 · 3 tools · last Write auth.test.ts · ↑28k ↓2.6k
done (3)
✓ Check schema diff · Explore · haiku/low · 5.1k tok · 1m12s
✓ Tidy API docs · general-purpose · sonnet/medium · 22k tok · 2m40s
✗ Run e2e · general-purpose · opus/high · 15k tok · failed: error
Updated 2s ago  current task reported by the model
[ Clear finished ][ Close ]
```

## Usage

Set up OpenSpec's slash commands and skills in the project with `openspec init`, then work as usual; the mod only watches events and draws.

| Command | Effect |
|---|---|
| `/opsx-board` | Toggle the pane |
| `/opsx-board clear` | Drop finished sub agents (running and waiting ones stay) |
| `/opsx-board off` | Hide the band, pane and status line; events are still recorded. `/opsx-board` resumes |
| `/opsx-board demo` | Show fake data; run it again to leave |

The pane opens by itself when the apply phase starts or the first sub agent spawns (see settings). A pane nobody asked for is only drawn in a terminal at least 144 columns wide; narrower, it waits for your `/opsx-board`.

### Language

The UI, toasts, command output and the texts the model reads (tool description, reporting rule, reminders) come in English, Traditional Chinese and Japanese. The `language` setting picks one; `auto` (the default) reads `LC_ALL`, then `LC_MESSAGES`, then `LANG`: any `zh*` locale → `zh-TW`, `ja*` → `ja`, everything else (including `C` and `POSIX`) → `en`. Task titles, change names, agent descriptions and tool summaries are shown as they are.

### How the phase is detected

| Source | What it gives |
|---|---|
| `/opsx:<kind> [change]` command | phase = `<kind>`; the first argument is taken as the change name when it looks like one |
| `openspec-<kind>` skill (triggered by the model or through the Skill tool) | the phase (`openspec-apply-change` → apply, and so on) |
| `openspec status/instructions/show/validate … --change X` in Bash | the change name |
| `openspec new change X` in Bash | phase propose, change X |
| a successful `openspec archive` in Bash | back to idle, task list dropped |
| reads and edits under `openspec/changes/<change>/…` | the change name (`archive/` does not count) |

When only tasks.md has been read and no phase was entered, the band shows `⧉ opsx <change> · …` without claiming apply; editing a checkbox in tasks.md directly counts as apply.

### Task reporting: the `mcp__opsx-board__task` tool

The mod registers a tool the model can call (Claude Code lists every plugin tool as `mcp__<plugin>__<name>`; OpenSpec itself is not an MCP server):

```
mcp__opsx-board__task { "task_id": "3.2", "status": "start" }   → the pane shows "▶ 3.2 …" (reported by the model)
mcp__opsx-board__task { "task_id": "3.2", "status": "done" }    → the mod rewrites that tasks.md line to [x] and answers with progress and the next task
```

The model no longer edits checkboxes itself, and the board's current task becomes a declared value instead of a guess. Three layers make the model actually do it:

1. **Rule injection** (`inject_instructions`, on by default): the reporting rule is appended to the `openspec-apply-change` skill text, and repeated as a session-scoped section of the system prompt while in the apply phase, so it survives compaction.
2. **Direct edits**: when the model still edits tasks.md itself, one tick passes; several ticks at once get a one-line reminder attached to the tool result (the model sees it, you do not).
3. **Strict mode** (`strict`, off by default): an edit that ticks several tasks at once is refused and the model is told to use the tool. The file is not touched.

tasks.md stays the source of truth: if the model ignores the tool entirely, the board is only coarser, never wrong.

### Sub agent columns

| Column | Source |
|---|---|
| name, type | `agent.spawn`'s `description` and `subagentType` |
| model | the model the spawn resolved to; afterwards whatever the API reports |
| effort | the effort of the agent's first model request (`turn.step`) |
| tokens | the agent's model requests summed (input + output + cache read + cache write); on the second line `↑` is the input side, `↓` the output |
| step / tools / last | model requests, tool calls, the last tool call's summary |
| running / waiting | since the spawn; "waiting" comes from `$.agent.list()` (plan approval, background work) |
| end | `turn.complete`: answer → ✓, aborted → ■, anything else → ✗ with the reason |

A toast fires when a sub agent starts and when it ends (with tokens and duration). At most 50 are kept; past that, the earliest finished ones are dropped first.

## Settings

In `/plugin`'s configure page or under `pluginConfigs` in `~/.claude/settings.json`:

| Field | Default | Meaning |
|---|---|---|
| `language` | `auto` | `auto`, `en`, `zh-TW` or `ja` (see Language above) |
| `strict` | `false` | Refuse an Edit/Write that ticks several tasks at once |
| `inject_instructions` | `true` | Add the reporting rule to the apply skill and the apply-phase system prompt |
| `auto_open` | `true` | Open the pane when apply starts or the first sub agent spawns |

## Safety boundary

- **One kind of write only**: `openspec/changes/<change>/tasks.md` under the session's project root, and only one line's `[ ]` becomes `[x]`. When the change or the file cannot be found, the model gets an error; nothing is guessed.
- No external commands (not even the `openspec` CLI; the phase comes from events alone), no network, no model calls.
- The only text added to prompts is the fixed task-reporting rule, which `inject_instructions` turns off.
- The only files read are tasks.md and the directory listing of `openspec/changes/`. Environment reads: `LC_ALL`, `LC_MESSAGES`, `LANG` (for `language: auto`).

## What it does before you install it

```bash
claude plugin validate ./plugins/opsx-board
```

Result (v0.1.0):

```
hooks: session.start, command.run{command=opsx-board}, ui.close, command.run{command=/"^opsx[:/]"/},
       skill.prompt{skill=/"^openspec-"/}, prompt.compose, tool.call{tool=/"^mcp__opsx-board__task$"/}, tool.call,
       agent.spawn, turn.step, turn.complete, ui.render{component=AbovePrompt},
       ui.render{component=Pane, requestId=opsx-board}
calls: $.agent.list, $.clock.every, $.clock.now, $.command.register, $.env.get, $.fs.list, $.fs.read,
       $.fs.write, $.session.root, $.state.get, $.state.set, $.tool.register, $.ui.close, $.ui.open,
       $.ui.resolve, $.ui.status, $.ui.toast
env reads: LANG, LC_ALL, LC_MESSAGES
env writes: nothing
```

The unmatched `tool.call` hook reads paths, Bash commands and sub agents' calls; it only changes a result on a multi-tick edit of tasks.md (a reminder, or a refusal in strict mode) and passes everything else through untouched.

## Limits

- Without a tool report, the current task is a guess: the first undone task.
- Agents that run remotely (cloud) produce no model-request events locally, so their tokens are not seen; agents a Workflow spawns have tokens but are not listed by `$.agent.list()`, so "waiting" is not seen for them.
- `claude -p` starts no timer, so "running N s" does not advance there.
- A tasks.md item must look like `- [ ] 1.2 text` (the number is digits and dots); other shapes are not tasks.

## Development

```bash
claude --plugin-dir ./plugins/opsx-board   # load once
claude plugin test ./plugins/opsx-board     # run the tests
```

`tsconfig.json` depends on `.claude-plugin/types/`, the type declarations Claude Code writes when it loads the mod; they are not committed.
