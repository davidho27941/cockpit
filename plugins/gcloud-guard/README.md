# gcloud-guard

Holds a `gcloud` or `gsutil` command that would create, change or delete cloud resources before Claude runs it, shows which account and project it would hit and what the targets look like right now, and opens a pane with **Proceed** and **Cancel**. Cancel refuses the command and tells Claude why, so it knows nothing ran. Read-only commands (`describe`, `list`, `ls`, `get-iam-policy`, …) and local ones (`auth login`, `components update`) pass straight through.

The hold-and-ask pattern follows Anthropic's blast-radius mod in this repo; the code is written fresh (MIT) and aimed at Google Cloud.

```
╭─ ⚠ gcloud-guard · destructive ──────────────────────────────────────────────╮
│ delete compute instances web-1, web-2                                       │
│ Command   gcloud compute instances delete web-1 web-2 --zone us-central1-a  │
│ Account   dev@example.com                                                   │
│ Project   demo-proj  ← from gcloud config  · Config default                 │
│ Location  us-central1-a                                                     │
│                                                                             │
│   web-1 · RUNNING · us-central1-a · e2-small · created 2026-09-01 · 2 disks │
│   web-2 · TERMINATED · us-central1-a · e2-medium · created 2026-09-03       │
│ web-2: deletion protection is on; a delete fails unless it is turned off    │
│                                                                             │
│ 1: Proceed   2: Cancel   Claude is waiting on your answer                   │
╰─────────────────────────────────────────────────────────────────────────────╯
```

## What it holds

The command line is split on `&&`, `||`, `;`, `|` and newlines; `VAR=value`, `sudo`, `env`, `nohup`, `time`, `nice` and `( … )` wrappers are stripped; the first `gcloud` (or `gsutil`) segment that would change something decides. The first word after `gcloud` is the command group, the first table word after it is the verb.

| Severity | gcloud verbs | gsutil |
|---|---|---|
| **destructive** | `delete`, `remove`, `destroy`, `purge`, `rm`, `rb`, `reset`, `abandon`, `cancel`, `revoke`, `wipe`, `detach`, `rollback`, `unregister`, `unbind`, `uninstall`, `terminate`, and the prefixes `remove-*`, `delete-*`, `detach-*`, `revoke-*`, `unregister-*`, `unbind-*`, `drop-*`, `purge-*`, `destroy-*`; `remove-iam-policy-binding` | `rm`, `rb`; `notification delete`, `… clear` |
| **mutating** | `update`, `patch`, `set`, `enable`, `disable`, `start`, `stop`, `suspend`, `resume`, `resize`, `move`, `rename`, `promote`, `failover`, `restart`, `reboot`, `attach`, `migrate`, `apply`, `replace`, `restore`, `import`, `export`, `upload`, `rotate`, `activate`, `deactivate`, `deploy`, `submit`, `execute`, `run`, `trigger`, `undelete`, `rsync`, `cp`, `mv`, and the prefixes `update-*`, `set-*`, `add-*`, `attach-*`, `start-*`, `stop-*`, `enable-*`, `disable-*`, `restore-*`, `resize-*`, `rotate-*`, …; `add-iam-policy-binding`, `set-iam-policy`; `config set` / `unset` / `configurations activate` (see below) | `cp`, `mv`, `rsync`, `setmeta`, `compose`, `rewrite`; `iam ch`, `acl set`, `defacl set`, `lifecycle set`, `versioning set`, `cors set`, `label set`, `retention set`, … |
| **create** | `create`, `add`, `insert`, `clone`, `snapshot`, `publish`, `register`, `reserve`, `provision`, and `create-*` | `mb`; `notification create` |

Special cases:

- **Whole projects, organizations, folders**: `gcloud projects delete`, `organizations delete`, `folders delete` are destructive with a scope badge; the pane shows the project's state, when it was created and how many services are enabled, and reminds you of the 30-day recovery window.
- **`deploy`** (`run deploy`, `app deploy`, `functions deploy`): mutating, labelled as a deploy, since it creates or replaces a revision. **`builds submit`**: mutating, labelled as a build.
- **IAM bindings**: the member and role are shown; for `set-iam-policy` the number of bindings in the policy file is compared with the current policy.
- **Storage** (`gcloud storage rm/mv/rsync`, `gsutil rm/rb/mv/rsync`): the objects under each source URL are counted with a read-only `ls -r` (capped at 2000); `rsync -d` / `--delete-unmatched-destination-objects` gets a warning.
- **`gcloud config set`** (and `unset`, `configurations activate`): held as a local-config change, because switching the project or account silently changes what every later command hits. The pane shows the current value. Turn this off with `hold_config_set`.
- **An unknown action verb under a known group** (`gcloud compute instances perform-rollout …`): held as mutating with a note, to be safe. An unknown verb under an unknown group is not held.

Never held: `describe`, `list`, `get`, `get-iam-policy`, `get-value`, `get-credentials`, `ls`, `cat`, `stat`, `du`, `logs`, `read`, `tail`, `print-access-token`, `ssh`, `scp`, `wait`, `test-iam-permissions`, the `list-*` / `describe-*` / `get-*` / `print-*` prefixes; the whole `auth`, `components`, `help`, `info`, `version`, `emulators` and `init` groups; `config list` / `get-value`; `container clusters get-credentials` (it only writes your kubeconfig); `compute ssh` / `scp` (a remote shell is not a resource change; see Limits).

## What the pane shows

- The headline in red (destructive), yellow (mutating) or green (create).
- The command on one line; the **account** and **project** it would hit, with where the project came from (`--project` or the gcloud config) and the active configuration; the **location** (`--zone` / `--region` / `--location`, or `(default)`); an alpha/beta badge; a yellow warning when `--quiet` is given, since gcloud then skips its own confirmation.
- For delete- and update-class commands, one line per target (up to 5) from a read-only `describe --format=json`: name, status, zone/region, machine type, database version and tier, size, node count, creation date, labels, attached disks and how many are auto-delete, IAM bindings. Deletion protection raises a note. A target that is not found raises a note too: the delete would fail, or hit something else than you think.
- For create-class commands, the sizing flags (`--machine-type`, `--size`, `--tier`, `--num-nodes`, `--image`, `--memory`, `--cpu`, …).
- When `gcloud` is not on `PATH` or does not answer, the pane says so and the command is still held.

## Context line

At all times, not only while holding, a dim line above the prompt says which project the session is pointed at, so a `gcloud … delete` is never a surprise about *where*:

```
☁ gcloud · project side-project-staging · account dev@example.com · config default · GKE my-cluster (us-central1)
```

Where the values come from (files and environment variables only; no `gcloud` process is started for this line):

| Part | Source |
|---|---|
| config directory | `$CLOUDSDK_CONFIG`, else `~/.config/gcloud` |
| configuration | `$CLOUDSDK_ACTIVE_CONFIG_NAME`, else the `active_config` file, else `default` |
| project, account, zone, region | `$CLOUDSDK_CORE_PROJECT`, `$CLOUDSDK_CORE_ACCOUNT`, `$CLOUDSDK_COMPUTE_ZONE`, `$CLOUDSDK_COMPUTE_REGION`, else `configurations/config_<name>` (`[core] project = …`, `[compute] zone = …`) |
| GKE cluster | the `current-context:` line of `$KUBECONFIG` (colon-separated; the first file with a current context wins), else `~/.kube/config`; a `gke_<project>_<location>_<cluster>` context is shown as `GKE <cluster> (<location>)` |

A project that comes from `CLOUDSDK_CORE_PROJECT` is marked ` ← CLOUDSDK_CORE_PROJECT`. Parts that are unknown are left out; when nothing is known (no gcloud configuration at all) the line is not drawn. A kubectl context that is not a GKE cluster (`docker-desktop`, an EKS ARN) is shown as `k8s <name>` only with `show_other_contexts` on.

The line is re-read at session start, every 5 seconds when one of those files' modification times changed (a cheap `stat`, no read otherwise), after a held `gcloud` / `gsutil` command proceeds, and after any Bash command that mentions `gcloud config`, `gcloud auth`, `gcloud container clusters get-credentials`, `kubectl config use-context` or `kubectx`. While a command is held, the hold report replaces the line; the hold pane also shows the GKE cluster, in yellow when the cluster's project differs from the project the command would hit.

`/gcloud-guard` prints the whole snapshot (config directory, configuration, project and its source, account, zone/region, kubeconfig path, current context, the parsed GKE fields) and the hold setting; `/gcloud-guard off` / `on` hide and show the line for the session; `/gcloud-guard refresh` re-reads the files now.

## Usage

It works as soon as it is installed. The only command is `/gcloud-guard` (above).

- When the pane appears, press `1` for Proceed or `2` for Cancel. **Prefer the digits.**
- Arrow keys, Tab and Enter only work while the pane actually holds the keyboard. The pane *requests* focus when it opens, and Claude Code grants it only over an empty composer. If the composer has text, or the terminal is too narrow and the report is drawn in the band above the prompt instead, the keys stay with the composer. An Enter there is read by Claude Code as "background this turn once the current tool finishes": the session is continued under a new session id and the transcript shows `Backgrounding after the current tool finishes…`. To use the arrows, click the pane first, or press `ctrl+x` then `tab` to hand it the keyboard.
- Cancel has the focus when the pane does hold the keyboard, so Enter there refuses the command.
- No answer within 10 minutes refuses the command. Interrupting the turn (Esc) refuses it too.
- One command is held at a time. A second risky call (from a subagent, say) waits until the first is answered.

## Settings

| Option | Default | Meaning |
|---|---|---|
| `language` | `auto` | Language of the pane, the toast and the refusal: `auto` (from `LC_ALL`, then `LC_MESSAGES`, then `LANG`: `zh*` gives Traditional Chinese, `ja*` Japanese, anything else English), `en`, `zh-TW` or `ja`. |
| `hold` | `all` | `destructive` holds delete-class commands only; `mutating` holds delete- and update-class; `all` also holds create-class. |
| `include_gsutil` | `true` | Also watch `gsutil`. |
| `hold_config_set` | `true` | Hold `gcloud config set` / `unset` / `configurations activate`. |
| `describe_timeout_seconds` | `15` | How long each read-only lookup may take before it is reported as failed (3 to 60). |
| `show_context` | `true` | Draw the context line above the prompt. |
| `show_other_contexts` | `false` | Also show the current kubectl context when it is not a GKE cluster. |

Set them with `/plugin configure gcloud-guard@cockpit`, or `--config hold=destructive` at install. Command words in the pane (`delete`, `compute instances`, …) are never translated. Every refusal ends with the same English line, `(gcloud-guard: the user did not approve this command; do not retry unless asked.)`, so Claude reads a Japanese or Chinese refusal as a refusal, not as a transient error.

## Beside the other mods in this repo

- Its context line stacks above the lines of opsx-board, auto-handover and cache-keeper with a thin rule between, like theirs. While it holds a command and the pane cannot be placed, the hold report takes over the band; the other lines return once you answer.
- blast-radius and gcloud-guard can both be installed: each watches its own commands. A line such as `gcloud compute instances delete x && rm -rf build` is held by both, one after the other.

## Safety boundary

- Every lookup is a read-only gcloud / gsutil command run by argv (`$.process.run`), never through a shell: a target name, a URL or a flag value is one argv element, so nothing in it runs as shell. The lookups are `config get-value`, `config configurations list`, `describe`, `get-iam-policy`, `projects describe`, `services list`, `storage ls -r` / `gsutil ls -r`.
- For the context line it reads, read-only, the gcloud configuration files (`active_config`, `configurations/config_<name>`) and the `current-context:` line of your kubeconfig, and stats them every 5 seconds. It reads the policy file named on `set-iam-policy` to count its bindings. It writes no files, sends nothing anywhere and calls no model.
- The lookups run with your credentials and need the matching `get` / `list` permissions; where they fail the pane says so and the command is still held.
- It is a safety net, not IAM. After Proceed the command runs as written, with no sandbox. For a hard block use [permission rules](https://code.claude.com/docs/en/settings) or the project's IAM.

## What it does, before you install it

```bash
claude plugin validate ./plugins/gcloud-guard
```

Result (v0.1.0):

```
hooks: session.start, command.run{command=gcloud-guard}, tool.call{tool=Bash},
       ui.render{component=Pane, requestId=gcloud-guard}, ui.render{component=AbovePrompt}
calls: $.clock.every, $.clock.now, $.command.register, $.env.get, $.fs.read, $.fs.stat,
       $.process.run, $.state.get, $.state.set, $.ui.close, $.ui.invalidate, $.ui.open,
       $.ui.resolve, $.ui.toast
env reads: CLOUDSDK_ACTIVE_CONFIG_NAME, CLOUDSDK_COMPUTE_REGION, CLOUDSDK_COMPUTE_ZONE,
           CLOUDSDK_CONFIG, CLOUDSDK_CORE_ACCOUNT, CLOUDSDK_CORE_PROJECT, HOME, KUBECONFIG,
           LANG, LC_ALL, LC_MESSAGES · env writes: nothing
```

`$.process.run` runs the read-only lookups above and the 0.25-second `sleep` that paces the hold; `$.fs.read` and `$.fs.stat` read the gcloud and kube config files for the context line and a `set-iam-policy` file; `$.clock.every` is the 5-second file check; no network of its own, no model calls.

## Limits

- It reads the command text; it is not a shell parser. `$(…)`, aliases, `eval`, `bash -c "…"`, `xargs gcloud`, scripts and Makefiles that call gcloud, `terraform`, `kubectl`, `bq`, the Python client libraries and the Console are not covered.
- `compute ssh` is not held, although a command run on the VM can change anything there.
- Flag parsing is heuristic: `--flag value` is read as a value unless the flag is a known boolean (`--quiet`, `--async`, `--force`, `--to-latest`, `--no-*`, `--enable-*`, …). A boolean flag it does not know, followed by a resource name, swallows that name from the target list; the command is still held.
- The verb tables cover the common groups. A verb that is not in them is held only when it looks like an action (`perform-*`, `trigger-*`, …) under a known group; anything else is let through. `gcloud` grows faster than this table.
- `describe` needs permissions and time: up to 5 targets, each with the configured timeout, plus the config lookups. On a slow network the pane can take a few seconds to appear; the command is held from the start regardless.
- Object counting for storage lists up to 2000 objects per URL and then says `2000+`; `gsutil ls -r` on a huge bucket may hit the timeout, which is reported as a note.
- One command is held at a time; a second waits.
- The context line reads the files gcloud and kubectl read, not what they would resolve: a `--project` on a later command, a `gcloud config set` in another shell before the next 5-second check, or a kubeconfig merged from several files with no `current-context:` in the first one can make the line lag or differ. `/gcloud-guard refresh` re-reads at once.
- Verified in the test kit against a stand-in for gcloud and a fake file system; in a live session a `gcloud config set` was held, the pane showed the account and project, and Proceed ran it.

## Development

```bash
claude --plugin-dir ./plugins/gcloud-guard   # load once
claude plugin validate ./plugins/gcloud-guard
claude plugin test ./plugins/gcloud-guard     # classifier table, lookups, the hold with a fake gcloud
```

The classifier and the report text live in `hooks/logic.ts` (pure), the strings in `hooks/i18n.ts`, the hooks and the drawing in `hooks/register.tsx`. If blast-radius is installed while you work on this mod, write test files with the editor rather than a heredoc: a literal `rm -rf` in a Bash command line is held by it.
