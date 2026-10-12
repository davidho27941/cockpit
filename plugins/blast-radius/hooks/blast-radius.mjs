// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Modified by davidho27941 (2026-10-04): added a "language" userConfig option and
// moved the user-facing strings into hooks/i18n.mjs (English, Traditional Chinese,
// Japanese). Logic unchanged. `classify` is exported for the tests.
//
// Modified by davidho27941 (2026-10-05): renamed draw()'s first parameter from `t`
// to `ui`; it shadowed the imported translation function, so every pane rendered
// empty and every hold ended in the error refusal.
//
// Modified by davidho27941 (2026-10-12): the pane shows the command one segment per row
// (split where classify() splits it), the risky segment marked and coloured (command and
// flags red, targets yellow), long chains folded; classify() adds `segmentIndex` to the
// risk it returns; the pane no longer draws a second border inside its own frame (the
// band keeps one) and its sections are spaced. Classification, measuring and holding
// are unchanged.
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): if the command is risky, work out its blast radius, open a
// pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

import { resolveLang, t } from "./i18n.mjs";

const PANE_ID = "blast-radius";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;
// The language the pane and the refusals use: the option, else the locale, else English.
let lang = resolveLang(undefined, {});

export function register(on, options) {
  const languageOption = options?.language;
  lang = resolveLang(languageOption, {});
  on("session.start", async ($, e, next) => {
    const out = await next(e);
    try {
      const env = { LC_ALL: await $.env.get("LC_ALL"), LC_MESSAGES: await $.env.get("LC_MESSAGES"), LANG: await $.env.get("LANG") };
      lang = resolveLang(languageOption, env);
    } catch {
      // the locale is unreadable: keep the option or English
    }
    return out;
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const risk = classify(String(e.command ?? ""));
    if (risk === null) {
      return next(e);
    }
    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    while (held !== null) {
      if (next.signal.aborted) {
        return { deny: t(lang, "denyInterrupted") };
      }
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine = { command: String(e.command), risk, report: null, decision: null, where: "pane" };
    held = mine;

    let opened = { isPlaced: false };
    let decision;
    let summary = risk.label;
    try {
      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd();
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
      mine.report = cwd === null
        ? { summary: t(lang, "inDir", { label: risk.label, dir: risk.dir }), lines: [], note: t(lang, "noDir", { dir: risk.dir }) }
        : await measure($, risk, cwd);
      summary = mine.report.summary;

      opened = await $.ui.open({ id: PANE_ID, title: "Blast Radius", focus: true, rows: paneRows(mine.report, mine.command) });
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
      }
    } catch {
      mine.decision = "error"; // anything unexpected refuses the command
    } finally {
      decision = mine.decision;
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    if (decision === "proceed") {
      $.ui.toast(t(lang, "running"));
      return next(e);
    }
    const why = {
      cancel: t(lang, "whyCancel"),
      timeout: t(lang, "whyTimeout"),
      interrupted: t(lang, "whyInterrupted"),
      error: t(lang, "whyError"),
    }[decision] ?? t(lang, "whyUnknown");
    return {
      deny: t(lang, "deny", { why, summary }),
    };
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The first risky segment of a shell command, or null. */
export function classify(command) {
  let dir = null; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  let segmentIndex = -1;
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    segmentIndex += 1;
    const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = (tail.match(/\)+\s*$/)?.[0].trim().length) ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    const risk = classifySegment(raw, dir, pushed);
    if (risk !== null && risk.cd === undefined) {
      return { ...risk, segmentIndex }; // which segment, for the pane's highlight only
    }
    if (risk !== null) {
      dir = risk.cd; // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop(); // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment, dir, pushed) {
  {
    const words = tokenize(segment.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, ""));
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words.shift(); // leading VAR=value
    }
    if (words[0] === "sudo") {
      words.shift();
      while (words.length > 0 && words[0].startsWith("-")) {
        const option = words.shift();
        if (SUDO_VALUE_OPTIONS.has(option)) {
          words.shift();
        }
      }
    }
    while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
      words.shift();
    }
    if (words[0] === "nice") {
      words.shift();
      if (words[0] === "-n") {
        words.splice(0, 2);
      } else if (/^-\d+$/.test(words[0] ?? "")) {
        words.shift();
      }
    }
    const [first, ...args] = words;
    if (first === undefined) {
      return null;
    }
    const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
    if (cmd === "cd") {
      return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
    }
    if (cmd === "pushd") {
      pushed.push(dir);
      return { cd: joinDir(dir, args[0]) };
    }
    if (cmd === "popd") {
      return { cd: pushed.length > 0 ? pushed.pop() : "-" };
    }
    if (cmd === "rm" || cmd.endsWith("/rm")) {
      const flags = args.filter((a) => a.startsWith("-"));
      const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
      const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
      if (recursive || force) {
        const targets = args.filter((a) => !a.startsWith("-") || a === "-");
        return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir };
      }
    }
    if (cmd === "git") {
      // Git's own options come before the subcommand; -C moves where it runs.
      let gitDir = dir;
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) {
        if (args[i] === "-C" && i + 1 < args.length) {
          gitDir = joinDir(gitDir, args[i + 1]);
          i += 2;
        } else if (args[i] === "-c" && i + 1 < args.length) {
          i += 2;
        } else {
          i += 1;
        }
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (sub === "reset" && rest.includes("--hard")) {
        return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
      }
      if (sub === "clean") {
        return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
      }
      if (sub === "push" && rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
        return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
      }
      const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
      if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !stagedOnly) {
        return { kind: "git-checkout", label: `git ${sub} -- .`, args: rest, dir: gitDir };
      }
    }
    const joined = words.join(" ");
    if (/\balembic\s+upgrade\b/.test(joined)) {
      return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir };
    }
    if (/\bdb:migrate(?!:status\b)/.test(joined)) {
      return { kind: "migrate", tool: "rails", label: "db:migrate", dir };
    }
    if (/\bprisma\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir };
    }
    if (/\bmanage\.py\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "django", label: "manage.py migrate", dir };
    }
    if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
      return { kind: "migrate", tool: "unknown", label: "migrate", dir };
    }
  }
  return null;
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`;

async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const run = await $.process.run(["bash", "-c", CD_SCRIPT, "blast-radius", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

// ---- Measuring the blast radius -------------------------------------------

/** { summary, lines, note } for the pane. Never throws: a failed read is said, not hidden. */
async function measure($, risk, cwd) {
  try {
    if (risk.kind === "rm") {
      return await measureRm($, risk, cwd);
    }
    if (risk.kind === "migrate") {
      return await measureMigrations($, risk, cwd);
    }
    return await measureGit($, risk, cwd);
  } catch (error) {
    return { summary: t(lang, "couldNotMeasure", { label: risk.label }), lines: [], note: t(lang, "couldNotMeasureNote", { error: String(error?.message ?? error).slice(0, 200) }) };
  }
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm($, risk, cwd) {
  if (risk.targets.length === 0) {
    return { summary: t(lang, "rmNoPaths"), lines: [], note: t(lang, "rmNoPathsNote") };
  }
  const run = await $.process.run(["bash", "-c", RM_SCRIPT, "blast-radius", ...risk.targets], { cwd, timeoutMs: 15000 });
  const [head, ...rest] = run.stdout.split("\n").filter((l) => l !== "");
  const [files, bytes, found] = (head ?? "0 0 0").split(" ").map(Number);
  if (!found) {
    return { summary: t(lang, "rmNothing", { targets: risk.targets.join(" ") }), lines: [], note: t(lang, "rmNothingNote") };
  }
  if (!files) {
    return { summary: t(lang, "rmEmpty", { found }), lines: [], note: t(lang, "rmPaths", { targets: risk.targets.join(" ") }) };
  }
  return {
    summary: t(lang, "rmFiles", { files, size: size(bytes) }),
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: t(lang, "rmPaths", { targets: risk.targets.join(" ") }),
  };
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-clean") {
    const flags = [];
    const paths = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i];
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
        if (kept !== "-") {
          flags.push(kept);
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run(["git", "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
    if (run.exitCode !== 0) {
      return { summary: t(lang, "cleanFailed"), lines: [], note: run.stderr.trim().slice(0, 200) };
    }
    const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
    return {
      summary: gone.length === 0 ? t(lang, "cleanNothing") : t(lang, "cleanRemove", { n: gone.length }),
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: t(lang, "cleanNote"),
    };
  }
  const status = await $.process.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: t(lang, "notRepo", { label: risk.label }), lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? t(lang, "discardNothing") : t(lang, "discard", { n: lost.length }),
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? t(lang, "discardStat", { stat: stat.stdout.trim() }) : t(lang, "discardNote"),
  };
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch) {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  } else if (branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: t(lang, "pushTo", { ref }), lines: [], note: t(lang, "pushUnknown", { ref }) };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: dropped.length === 0 ? t(lang, "pushNothing", { ref }) : t(lang, "pushDrops", { ref, n: dropped.length }),
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: t(lang, "pushNote", { ref, source }),
  };
}

const MIGRATION_LISTERS = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

async function measureMigrations($, risk, cwd) {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: t(lang, "migrateUnknown"), lines: [], note: t(lang, "migrateUnknownNote") };
  }
  let run;
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch (error) {
    run = { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
  if (run.exitCode !== 0) {
    return { summary: t(lang, "migrateRun", { label: risk.label }), lines: [], note: t(lang, "migrateListFailed", { argv: lister.argv.join(" ") }) };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return {
    summary: pending.length === 0 ? t(lang, "migrateNothing", { label: risk.label }) : t(lang, "migrateApply", { n: pending.length }),
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: t(lang, "migrateNote", { argv: lister.argv.join(" ") }),
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report, command = "") {
  return Math.min(30, 9 + commandLines(command, -1).length + report.lines.length + (report.more ? 1 : 0));
}

// ---- Showing the command ---------------------------------------------------

const SHOWN_SEGMENTS = 8; // more than this and the quiet ones around the risky one are folded
const COMMAND_PREFIXES = new Set(["sudo", "command", "exec", "env", "nohup", "time", "nice", "then", "do", "else", "!"]);
const HAS_SUBCOMMAND = new Set(["git", "alembic", "prisma", "npx", "python", "python3", "bin/rails", "rails", "rake", "bundle"]);

/**
 * The command split the way classify() splits it, one segment per row, each with the
 * operator that follows it (`&&`, `|`, `;`), so a long chain reads top to bottom.
 * Returns [{ text, op, isRisky }] or, when folded, a { fold: n } row in the middle.
 */
function commandLines(command, riskyIndex) {
  const parts = command.split(/(&&|\|\||;|\||\n)/);
  const rows = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i].trim();
    const op = parts[i + 1] === "\n" ? "" : (parts[i + 1] ?? "");
    if (text === "" && op === "") continue;
    rows.push({ text, op, isRisky: i / 2 === riskyIndex });
  }
  if (rows.length <= SHOWN_SEGMENTS) return rows;
  const at = Math.max(0, rows.findIndex((r) => r.isRisky));
  const from = Math.max(0, Math.min(at - 3, rows.length - SHOWN_SEGMENTS));
  const to = from + SHOWN_SEGMENTS;
  const out = [];
  if (from > 0) out.push({ fold: from });
  out.push(...rows.slice(from, to));
  if (to < rows.length) out.push({ fold: rows.length - to });
  return out;
}

/** The risky segment as coloured words: the command and its flags red, its targets yellow. */
function riskyWords(Text, text, keyBase) {
  const pieces = text.split(/(\s+)/);
  let seenHead = false;
  let wantSub = false;
  return pieces.map((piece, i) => {
    const key = `${keyBase}-${i}`;
    if (piece === "" || /^\s+$/.test(piece)) return piece;
    if (!seenHead) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(piece) || COMMAND_PREFIXES.has(piece)) {
        return Text({ key, dimColor: true, children: piece });
      }
      seenHead = true;
      wantSub = HAS_SUBCOMMAND.has(piece.replace(/^.*\//, "")) || HAS_SUBCOMMAND.has(piece);
      return Text({ key, color: "red", bold: true, children: piece });
    }
    if (piece.startsWith("-") || /^\+\S/.test(piece)) return Text({ key, color: "red", bold: true, children: piece });
    if (wantSub) {
      wantSub = false;
      return Text({ key, color: "red", bold: true, children: piece });
    }
    return Text({ key, color: "yellow", children: piece });
  });
}

function commandBlock(ui, state) {
  const { Box, Text } = ui;
  const rows = commandLines(state.command, state.risk.segmentIndex ?? -1).map((row, i) => {
    const key = `c${i}`;
    if (row.fold) return Text({ key, dimColor: true, children: `  ┆ ${t(lang, "more", { n: row.fold }).trim()}` });
    const op = row.op ? Text({ key: `${key}-op`, dimColor: true, children: ` ${row.op}` }) : null;
    if (row.isRisky) {
      return Text({ key, wrap: "wrap", children: [Text({ key: `${key}-m`, color: "red", bold: true, children: "  ▶ " }), ...riskyWords(Text, row.text, key), op] });
    }
    return Text({ key, wrap: "wrap", dimColor: true, children: [`  │ ${row.text}`, op] });
  });
  return Box({ key: "cmd", flexDirection: "column", children: [Text({ key: "cmd-label", dimColor: true, children: t(lang, "command") }), ...rows] });
}

function draw(ui, state) {
  const { Box, Text, Button } = ui;
  const { report } = state;
  const list = report.lines.map((line, i) => Text({ key: `l${i}`, children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ key: "more", dimColor: true, children: t(lang, "more", { n: report.more }) }));
  }
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  // The pane has its own frame and tab, so only the band draws a border of its own
  const frame = state.where === "band" ? { borderStyle: "round", borderColor: "yellow" } : {};
  return Box({
    flexDirection: "column",
    ...frame,
    paddingX: 1,
    children: [
      Text({ key: "title", bold: true, color: "yellow", children: t(lang, "title", { label: state.risk.label }) }),
      Text({ key: "gap-1", children: " " }),
      commandBlock(ui, state),
      Text({ key: "gap-2", children: " " }),
      Text({ key: "sum", children: [Text({ dimColor: true, children: t(lang, "would") }), Text({ color: "red", bold: true, children: report.summary })] }),
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ key: "note", dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: "proceed", label: t(lang, "proceed"), hotkey: "1", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: t(lang, "cancel"), hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ key: "hint", dimColor: true, children: t(lang, "waiting") }),
        ],
      }),
    ],
  });
}
