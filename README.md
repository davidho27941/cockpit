# cockpit

Instruments for a Claude Code session: a collection of [mods](https://code.claude.com/docs/en/plugins/mods/overview) by davidho27941. Three themes: show what an OpenSpec workflow and its sub agents are doing, hand over before compacting when the context fills up, and keep the prompt cache warm while a session idles. Plus two pre-flight checks: one vendored from Anthropic that holds risky shell commands, and one for Google Cloud changes.

Every mod's UI can be shown in English, Traditional Chinese or Japanese: set the `language` option (`auto`, `en`, `zh-TW`, `ja`; `auto` follows `LC_ALL` / `LC_MESSAGES` / `LANG`).

> Status: shared as-is, as a demonstration and a set of practical tools. No support is implied.

## Mods

| mod | What it does | Version |
|---|---|---|
| [`opsx-board`](plugins/opsx-board) | A board for OpenSpec projects: which phase you are in (propose / apply / archive), which task in `tasks.md` is being worked on, and one row per sub agent with its description, model/effort, token usage, step count, last tool and elapsed time. Registers a `task` tool so the model reports each task as it starts and finishes. | 0.1.0 |
| [`auto-handover`](plugins/auto-handover) | When context usage reaches your threshold, writes a handover note first, then compacts, and hands the note to the compacted conversation and to the next session in the same project. | 0.1.0 |
| [`cache-keeper`](plugins/cache-keeper) | Keeps the prompt cache warm while a session idles by sending one tiny request over the conversation prefix every 50 minutes (configurable), so the entry does not lapse after an hour. | 0.1.0 |
| [`gcloud-guard`](plugins/gcloud-guard) | Holds `gcloud` and `gsutil` commands that create, change or delete cloud resources. Shows the account, project, location and the resource's current state (via read-only `describe`), then asks you to Proceed or Cancel. Follows the blast-radius pattern, written fresh under MIT. | 0.1.0 |
| [`blast-radius`](plugins/blast-radius) | Holds a risky shell command (`rm -rf`, `git reset --hard`, `git clean`, force push, migrations), measures what it would change, and asks you to Proceed or Cancel. Vendored from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground) under Apache-2.0, with a `language` option added. | 0.1.0 (upstream) |

Each mod installs on its own. When several are installed, their lines above the prompt stack, separated by a thin rule; each pane has its own tab.

## Install

Requires Claude Code **2.1.289 or later** (`claude --version`).

Add the marketplace once:

```
/plugin marketplace add davidho27941/cockpit
```

Then install what you want:

```
/plugin install opsx-board@cockpit
/plugin install auto-handover@cockpit
/plugin install cache-keeper@cockpit
/plugin install blast-radius@cockpit
/plugin install gcloud-guard@cockpit
```

`claude plugin marketplace add …` and `claude plugin install …` work from a shell too. In a session that is already open, run `/reload-plugins`.

**Updates:** auto-update is off by default for third-party marketplaces. Turn it on for this marketplace in the Marketplaces tab of `/plugin`, or run `/plugin marketplace update cockpit`.

**Language:** each mod has a `language` setting (`/plugin configure <name>@cockpit`). `auto` picks Traditional Chinese for any `zh*` locale, Japanese for `ja*`, English otherwise.

## opsx-board: a board for OpenSpec

For projects that do spec-driven development with [OpenSpec](https://github.com/Fission-AI/openspec). When you type `/opsx:propose` or `/opsx:apply`, the board knows which phase you are in and which change you are on; in the apply phase it reads `tasks.md` and shows which task is up; every sub agent the model starts gets a row showing what it does, which model and effort it runs on, how many tokens it has used and how long it has run.

```
⧉ opsx apply add-auth · 3.2 Implement token refresh · 7/18 · ⚇ 2 agents running · 48k tok · 3s ago
```

Watching files alone has a blind spot: the model often finishes three or four tasks and then ticks all the checkboxes in `tasks.md` at once, so the progress display stalls. opsx-board therefore gives the model a tool, `mcp__opsx-board__task`, and asks it to report `start` before each task and `done` right after; the mod ticks the checkbox itself. A direct edit that flips several boxes at once gets a reminder (or is refused, with `strict` on). The `mcp__` prefix is how Claude Code names every tool a mod registers; it has nothing to do with MCP servers, and OpenSpec itself is not an MCP server.

Details: [plugins/opsx-board/README.md](plugins/opsx-board/README.md).

## auto-handover: hand over first, then compact

Claude Code compacts on its own when the context is nearly full, but by then the context that mattered is often what gets squeezed out. auto-handover lets you set a lower threshold (default 75%). When it is reached, the mod first asks the model, over the same conversation prefix via `$.model.fork` (served from the prompt cache, so it is cheap), to write a handover note with the most important state, saves it under `~/.claude/handovers/<project>/`, then triggers the compaction and appends the note to the compacted conversation. The next session in the same project receives the note as context while it is fresh (24 hours by default).

`/handover` shows the status, `/handover now` hands over immediately, `/handover show` prints the latest note.

Details and cost notes: [plugins/auto-handover/README.md](plugins/auto-handover/README.md).

## cache-keeper: keep the prompt cache warm

Claude Code's prompt cache entry lapses one hour after it was last used. Leave a long-context session alone for more than an hour and the next message rewrites the whole prefix into the cache: slower and more expensive. cache-keeper sends one "reply ok" request via `$.model.fork` every 50 minutes (configurable) while the session idles, which keeps the entry alive. It only pokes while idle, restarts the timer whenever a real request goes out, and stops after an idle cap (4 hours by default) so a session you forgot overnight does not keep paying.

```
♨ cache warm · next in 38m · 3 pokes · last hit 98k tok
```

Every poke bills the whole prefix at cache-read price. When that trade is worth it and when it is not: [plugins/cache-keeper/README.md](plugins/cache-keeper/README.md).

## blast-radius: measure the blast radius first

A sample mod Anthropic shared in claude-code-playground. When Claude is about to run `rm -rf`, `git reset --hard`, `git clean`, a force push or a migration, it holds the command, works out how many files would be deleted, which uncommitted changes would be lost, which commits would be overwritten or which migrations would be applied, and opens a pane with Proceed and Cancel. On Cancel, Claude receives the reason and does not retry. No commands to learn, no configuration beyond `language`.

While it holds a command it takes over the band above the prompt; the other three mods' lines step aside until you answer.

Origin, license and limits: [plugins/blast-radius/README.md](plugins/blast-radius/README.md). The upstream documentation and screenshots are in [README.upstream.md](plugins/blast-radius/README.upstream.md).

## gcloud-guard: measure a Google Cloud change first

The same hold-and-ask pattern as blast-radius, for the Google Cloud CLI. When Claude is about to run a `gcloud` or `gsutil` command that creates, changes or deletes a resource (`delete`, `update`, `patch`, `set-*`, `add-*`, `create`, `deploy`, `storage rm`, IAM bindings, `config set`, and more), the mod holds it and shows what matters most with gcloud: which **account** and **project** the command will hit and where that project came from (`--project` or the active configuration), the location, the alpha/beta track, whether `--quiet` suppresses gcloud's own confirmation, and for existing resources their current state from a read-only `describe`. Deleting a project shows the enabled services and the recovery window. Which severities are held is configurable (`all`, `mutating`, `destructive`).

Details, the full verb table and limits: [plugins/gcloud-guard/README.md](plugins/gcloud-guard/README.md).

## What each mod does before you install it

Mods do not run in a sandbox; they run inside Claude Code with your permissions. Read the source before installing, or clone and run `claude plugin validate ./plugins/<name>` to see which events it hooks and which capabilities it calls. Each mod's README carries the v0.1.0 result and its boundary. In short:

- **opsx-board**: writes only the checkbox of one line in `openspec/changes/*/tasks.md` under the project root; no network, no model calls; the only text it adds to the prompt is the task-reporting rule.
- **auto-handover**: reads and writes only under the user-level `handover_dir` (default `~/.claude/handovers`); one `$.model.fork` per handover plus the compaction's own summarizer request; no network, no shell.
- **cache-keeper**: no files, no shell; one tiny model request per interval, only while idle, never during a turn, and it stops past the idle cap.
- **gcloud-guard**: watches the Bash tool only; measures with read-only `gcloud … describe` / `config get-value` / `storage ls` calls, passing arguments as argv, never as shell source; no files beyond reading an IAM policy file named on the command line, no network of its own, no model calls. After Proceed the command runs as written.
- **blast-radius**: watches the Bash tool only; measures with `bash` / `find` / `du` / `git` and the migration tool's own status command, passing paths as arguments, never as shell source; no files, no network, no model calls. After Proceed the command runs as written: it is a safety net, not a sandbox.

## Development

```bash
claude --plugin-dir ./plugins/<name>   # load once
claude plugin validate ./plugins/<name> # what it hooks and calls
claude plugin test ./plugins/<name>     # run the tests
```

For ongoing work, add this folder as a local marketplace and install from it: the plugins are read straight from the folder (`claude plugin list` shows `Read from:` pointing here), they are present in every session, and after editing you run `/reload-plugins` inside Claude Code instead of reinstalling:

```bash
claude plugin marketplace add /path/to/cockpit
claude plugin install <name>@cockpit --scope user
```

Each plugin's `tsconfig.json` extends `.claude-plugin/types/`, the type declarations Claude Code writes when it loads the mod. That folder is in `.gitignore`.

## License

The four mods written here (opsx-board, auto-handover, cache-keeper, gcloud-guard) and the repository's root files are [MIT](LICENSE). `plugins/blast-radius/` comes from Anthropic's claude-code-playground under the Apache License 2.0, Copyright Anthropic PBC; the full license text and the list of modifications are in that folder's `LICENSE` and `NOTICE`.
