// Copyright 2026 davidho27941
// SPDX-License-Identifier: Apache-2.0
//
// User-facing strings of Blast Radius in English, Traditional Chinese and
// Japanese, and the language pick: the `language` option when it names one,
// else the locale (LC_ALL, LC_MESSAGES, LANG), else English.
//
// Every key exists in every language; `t` falls back to English for a key a
// dictionary lacks, so a missing translation shows English, never a blank.
// Command names (rm -rf, git reset --hard, ...) are not translated.

export const LANGS = ["en", "zh-TW", "ja"];
export const DEFAULT_LANG = "en";

/** The language to draw in: the option when it names one, else from the locale. */
export function resolveLang(option, env) {
  const picked = typeof option === "string" ? option.trim() : "";
  if (LANGS.includes(picked)) {
    return picked;
  }
  const e = env ?? {};
  const locale = [e.LC_ALL, e.LC_MESSAGES, e.LANG].find((v) => typeof v === "string" && v.trim() !== "") ?? "";
  const lower = locale.trim().toLowerCase();
  if (lower === "" || lower === "c" || lower === "posix" || lower.startsWith("c.") || lower.startsWith("posix.")) {
    return DEFAULT_LANG;
  }
  if (lower.startsWith("zh")) {
    return "zh-TW";
  }
  if (lower.startsWith("ja")) {
    return "ja";
  }
  return DEFAULT_LANG;
}

// An English tail every refusal carries, whatever the language, so the model
// never reads a Japanese or Chinese refusal as a transient error.
const DENY_TAIL = "(blast-radius: the user did not approve this command; do not retry unless asked.)";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const MESSAGES = {
  en: {
    // pane
    title: ({ label }) => `⚠ Blast Radius · ${label}`,
    command: "Command  ",
    would: "Would    ",
    more: ({ n }) => `  + ${n} more`,
    proceed: "Proceed",
    cancel: "Cancel",
    waiting: "Claude is waiting on your answer",
    running: "Blast Radius: running it",
    // refusals
    denyInterrupted: `Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to. ${DENY_TAIL}`,
    deny: ({ why, summary }) => `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to. ${DENY_TAIL}`,
    whyCancel: "the user pressed Cancel",
    whyTimeout: "no answer within 10 minutes",
    whyInterrupted: "the turn was interrupted",
    whyError: "Blast Radius hit an error while holding it",
    whyUnknown: "no answer was recorded",
    // measuring
    inDir: ({ label, dir }) => `${label} in ${dir}`,
    noDir: ({ dir }) => `Couldn't find the folder ${dir}, so I couldn't measure what this would change.`,
    couldNotMeasure: ({ label }) => `${label} (could not measure it)`,
    couldNotMeasureNote: ({ error }) => `Could not measure: ${error}`,
    rmNoPaths: "rm with no paths",
    rmNoPathsNote: "No paths to expand.",
    rmNothing: ({ targets }) => `delete nothing: no file matches ${targets}`,
    rmNothingNote: "The paths don't exist, so rm has nothing to remove.",
    rmEmpty: ({ found }) => `delete ${plural(found, "path", "paths")} with no files in ${found === 1 ? "it" : "them"}`,
    rmPaths: ({ targets }) => `Paths: ${targets}`,
    rmFiles: ({ files, size }) => `delete ${plural(files, "file", "files")} (about ${size})`,
    cleanFailed: "git clean (could not dry-run it)",
    cleanNothing: "remove nothing: no untracked files match",
    cleanRemove: ({ n }) => `remove ${n} untracked ${n === 1 ? "path" : "paths"}`,
    cleanNote: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    notRepo: ({ label }) => `${label} (not a git repo here?)`,
    discardNothing: "discard nothing: no uncommitted changes",
    discard: ({ n }) => `discard uncommitted changes in ${plural(n, "file", "files")}`,
    discardStat: ({ stat }) => `${stat}. Uncommitted changes can't be recovered.`,
    discardNote: "From git status --porcelain.",
    pushTo: ({ ref }) => `force-push to ${ref}`,
    pushUnknown: ({ ref }) => `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.`,
    pushNothing: ({ ref }) => `force-push to ${ref}: drops no commits`,
    pushDrops: ({ ref, n }) => `force-push to ${ref}: drops ${plural(n, "commit", "commits")}`,
    pushNote: ({ ref, source }) => `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
    migrateUnknown: "run migrations",
    migrateUnknownNote: "I can't list the pending migrations for this tool, so the list is not shown.",
    migrateRun: ({ label }) => `run ${label}`,
    migrateListFailed: ({ argv }) => `Couldn't list pending migrations (${argv} failed).`,
    migrateNothing: ({ label }) => `run ${label}: nothing pending`,
    migrateApply: ({ n }) => `apply ${n} pending ${n === 1 ? "migration" : "migrations"}`,
    migrateNote: ({ argv }) => `From ${argv}.`,
  },
  "zh-TW": {
    title: ({ label }) => `⚠ Blast Radius · ${label}`,
    command: "指令  ",
    would: "會    ",
    more: ({ n }) => `  還有 ${n} 個`,
    proceed: "執行",
    cancel: "取消",
    waiting: "Claude 在等你的回答",
    running: "Blast Radius：執行中",
    denyInterrupted: `Blast Radius 攔住了這個指令，沒有執行：這一輪被中斷了。除非使用者要求，否則不要重試。 ${DENY_TAIL}`,
    deny: ({ why, summary }) => `Blast Radius 攔住了這個指令，沒有執行：${why}。它原本會：${summary}。除非使用者要求，否則不要重試。 ${DENY_TAIL}`,
    whyCancel: "使用者按了取消",
    whyTimeout: "10 分鐘內沒有回答",
    whyInterrupted: "這一輪被中斷了",
    whyError: "Blast Radius 在攔住期間發生錯誤",
    whyUnknown: "沒有記錄到任何回答",
    inDir: ({ label, dir }) => `在 ${dir} 執行 ${label}`,
    noDir: ({ dir }) => `找不到資料夾 ${dir}，無法量測這個指令會改變什麼。`,
    couldNotMeasure: ({ label }) => `${label}（無法量測）`,
    couldNotMeasureNote: ({ error }) => `無法量測：${error}`,
    rmNoPaths: "rm 沒有指定路徑",
    rmNoPathsNote: "沒有可展開的路徑。",
    rmNothing: ({ targets }) => `不會刪任何東西：沒有檔案符合 ${targets}`,
    rmNothingNote: "這些路徑不存在，rm 沒有東西可刪。",
    rmEmpty: ({ found }) => `刪除 ${found} 個路徑，裡面沒有檔案`,
    rmPaths: ({ targets }) => `路徑：${targets}`,
    rmFiles: ({ files, size }) => `刪除 ${files} 個檔案（約 ${size}）`,
    cleanFailed: "git clean（無法試跑）",
    cleanNothing: "不會移除任何東西：沒有符合的未追蹤檔案",
    cleanRemove: ({ n }) => `移除 ${n} 個未追蹤的路徑`,
    cleanNote: "來自 git clean -n。未追蹤的檔案不在 git 裡，刪了就找不回來。",
    notRepo: ({ label }) => `${label}（這裡不是 git repo？）`,
    discardNothing: "不會丟掉任何東西：沒有未提交的修改",
    discard: ({ n }) => `丟掉 ${n} 個檔案的未提交修改`,
    discardStat: ({ stat }) => `${stat}。未提交的修改找不回來。`,
    discardNote: "來自 git status --porcelain。",
    pushTo: ({ ref }) => `強制推送到 ${ref}`,
    pushUnknown: ({ ref }) => `本機沒有 ${ref} 的副本，看不出這次推送會蓋掉哪些 commit。請先 git fetch。`,
    pushNothing: ({ ref }) => `強制推送到 ${ref}：不會蓋掉任何 commit`,
    pushDrops: ({ ref, n }) => `強制推送到 ${ref}：會蓋掉 ${n} 個 commit`,
    pushNote: ({ ref, source }) => `${ref} 上有、${source} 沒有的 commit，以上次 fetch 為準。`,
    migrateUnknown: "執行 migration",
    migrateUnknownNote: "無法列出這個工具的待執行 migration，所以不顯示清單。",
    migrateRun: ({ label }) => `執行 ${label}`,
    migrateListFailed: ({ argv }) => `無法列出待執行的 migration（${argv} 失敗）。`,
    migrateNothing: ({ label }) => `執行 ${label}：沒有待執行的項目`,
    migrateApply: ({ n }) => `套用 ${n} 個待執行的 migration`,
    migrateNote: ({ argv }) => `來自 ${argv}。`,
  },
  ja: {
    title: ({ label }) => `⚠ Blast Radius · ${label}`,
    command: "コマンド  ",
    would: "影響      ",
    more: ({ n }) => `  他 ${n} 件`,
    proceed: "実行",
    cancel: "キャンセル",
    waiting: "Claude はあなたの回答を待っています",
    running: "Blast Radius：実行します",
    denyInterrupted: `Blast Radius がこのコマンドを保留し、実行しませんでした：ターンが中断されました。ユーザーの指示がない限り再試行しないでください。 ${DENY_TAIL}`,
    deny: ({ why, summary }) => `Blast Radius がこのコマンドを保留し、実行しませんでした：${why}。実行していれば：${summary}。ユーザーの指示がない限り再試行しないでください。 ${DENY_TAIL}`,
    whyCancel: "ユーザーがキャンセルを押しました",
    whyTimeout: "10 分以内に回答がありませんでした",
    whyInterrupted: "ターンが中断されました",
    whyError: "Blast Radius が保留中にエラーになりました",
    whyUnknown: "回答が記録されていません",
    inDir: ({ label, dir }) => `${dir} で ${label}`,
    noDir: ({ dir }) => `フォルダ ${dir} が見つからないため、影響を測定できませんでした。`,
    couldNotMeasure: ({ label }) => `${label}（測定できませんでした）`,
    couldNotMeasureNote: ({ error }) => `測定できませんでした：${error}`,
    rmNoPaths: "rm にパスがありません",
    rmNoPathsNote: "展開するパスがありません。",
    rmNothing: ({ targets }) => `何も削除しません：${targets} に一致するファイルがありません`,
    rmNothingNote: "パスが存在しないため、rm が削除するものはありません。",
    rmEmpty: ({ found }) => `${found} 個のパスを削除（中にファイルはありません）`,
    rmPaths: ({ targets }) => `パス：${targets}`,
    rmFiles: ({ files, size }) => `${files} 個のファイルを削除（約 ${size}）`,
    cleanFailed: "git clean（ドライランできませんでした）",
    cleanNothing: "何も削除しません：一致する未追跡ファイルがありません",
    cleanRemove: ({ n }) => `${n} 個の未追跡パスを削除`,
    cleanNote: "git clean -n の結果。未追跡ファイルは git に無いため、復元できません。",
    notRepo: ({ label }) => `${label}（ここは git リポジトリではない？）`,
    discardNothing: "何も破棄しません：未コミットの変更がありません",
    discard: ({ n }) => `${n} 個のファイルの未コミット変更を破棄`,
    discardStat: ({ stat }) => `${stat}。未コミットの変更は復元できません。`,
    discardNote: "git status --porcelain の結果。",
    pushTo: ({ ref }) => `${ref} へ強制プッシュ`,
    pushUnknown: ({ ref }) => `${ref} のローカルコピーが無いため、どのコミットが失われるか分かりません。先に git fetch してください。`,
    pushNothing: ({ ref }) => `${ref} へ強制プッシュ：失われるコミットはありません`,
    pushDrops: ({ ref, n }) => `${ref} へ強制プッシュ：${n} 件のコミットが失われます`,
    pushNote: ({ ref, source }) => `${ref} にあって ${source} に無いコミット（最後の fetch 時点）。`,
    migrateUnknown: "マイグレーションを実行",
    migrateUnknownNote: "このツールの未適用マイグレーションを一覧できないため、リストは表示しません。",
    migrateRun: ({ label }) => `${label} を実行`,
    migrateListFailed: ({ argv }) => `未適用マイグレーションを一覧できませんでした（${argv} が失敗）。`,
    migrateNothing: ({ label }) => `${label} を実行：未適用はありません`,
    migrateApply: ({ n }) => `${n} 件の未適用マイグレーションを適用`,
    migrateNote: ({ argv }) => `${argv} の結果。`,
  },
};

/** The string for `key` in `lang` (English when the dictionary lacks it), with `params` applied. */
export function t(lang, key, params = {}) {
  const dict = MESSAGES[lang] ?? MESSAGES[DEFAULT_LANG];
  const entry = dict[key] ?? MESSAGES[DEFAULT_LANG][key];
  if (entry === undefined) {
    return key;
  }
  return typeof entry === "function" ? entry(params) : entry;
}
