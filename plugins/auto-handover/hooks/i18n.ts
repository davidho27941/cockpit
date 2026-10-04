// auto-handover i18n: the language choice and every user- or model-facing string.
// Pure: no `$`. Shared by logic.ts, register.tsx and the tests.

export type Lang = 'en' | 'zh-TW' | 'ja'
export const LANGS: readonly Lang[] = ['en', 'zh-TW', 'ja']
export const DEFAULT_LANG: Lang = 'en'

export type LangEnv = { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string }

/** Picks the language: an explicit option wins; `auto` (or anything else) reads LC_ALL, then LC_MESSAGES, then LANG. */
export function resolveLang(option: unknown, env: LangEnv): Lang {
  if (option === 'en' || option === 'zh-TW' || option === 'ja') return option
  for (const raw of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const v = (raw ?? '').trim()
    if (!v) continue
    if (v === 'C' || v === 'POSIX') return 'en'
    const lower = v.toLowerCase()
    if (lower.startsWith('zh')) return 'zh-TW'
    if (lower.startsWith('ja')) return 'ja'
    return 'en'
  }
  return DEFAULT_LANG
}

type Params = Record<string, string | number>
type Msg = string | ((p: Params) => string)

const EN = {
  // band
  'band.failure': (p: Params) => `⟲ auto-handover: ${p.reason}`,
  'band.writing': '⟲ Handing over: asking the model for a note…',
  'band.compacting': '⟲ Handing over: note written, compacting…',
  'band.context': (p: Params) => `⟲ context ${p.percent} / threshold ${p.threshold}%`,
  'band.paused': 'paused',
  'band.last': (p: Params) => `last handover ${p.ago} ago`,
  // /handover status
  'status.head': (p: Params) => `auto-handover: threshold ${p.threshold}%, context now ${p.percent}${p.paused}`,
  'status.noReading': 'no reading yet',
  'status.pausedSuffix': ' (paused)',
  'status.dir': (p: Params) => `Notes folder: ${p.dir}`,
  'status.failure': (p: Params) => `Disabled: ${p.reason}`,
  'status.ready': 'Status: conditions met, handing over after the next turn ends',
  'status.gate': (p: Params) => `Status: ${p.reason}`,
  'status.last': (p: Params) => `Last handover: ${p.ago} ago (${p.trigger}, ${p.percent}%${p.after}), ${p.file}`,
  'status.lastNone': 'Last handover: none in this session',
  'status.count': (p: Params) => `${p.count} handover(s) this session. /handover now to hand over now, /handover show for the latest note, /handover off to pause.`,
  // gate reasons
  'gate.paused': 'paused with /handover off',
  'gate.inFlight': 'a handover is in progress',
  'gate.turnRunning': 'a turn is running; waiting for it to end',
  'gate.noReading': 'no usage reading yet',
  'gate.below': (p: Params) => `usage ${p.percent}% is below the ${p.threshold}% threshold`,
  'gate.cooldown': (p: Params) => `cooling down (last handover ${p.ago} ago, cooldown ${p.minutes} min)`,
  // handover_dir checks
  'dir.empty': 'handover_dir is empty',
  'dir.badChars': 'handover_dir contains an invalid character',
  'dir.notAbsolute': (p: Params) => `handover_dir must be ~/… or an absolute path (got ${p.value})`,
  'dir.dotdot': 'handover_dir must not contain ..',
  'dir.outsideHome': (p: Params) => `handover_dir ${p.path} is outside your home directory; writing nothing`,
  'home.unset': 'cannot find your home directory (HOME is unset); writing nothing',
  // commands
  'cmd.inFlight': 'auto-handover: a handover is in progress.',
  'cmd.nowTurnRunning': 'auto-handover: a turn is running; handing over and compacting once it ends.',
  'cmd.nowScheduled': (p: Params) => `auto-handover: handing over in about ${p.seconds} s (write note → compact → append note to the conversation).`,
  'cmd.off': 'auto-handover paused: no automatic handovers (/handover now still works). /handover on to resume.',
  'cmd.on': 'auto-handover resumed.',
  'cmd.noNote': 'auto-handover: no handover note yet.',
  'cmd.unreadable': (p: Params) => `auto-handover: cannot read ${p.file}`,
  'cmd.usage': 'Usage: /handover (status), /handover now (hand over now), /handover show (latest note), /handover off|on',
  // toasts
  'toast.failed': (p: Params) => `⟲ auto-handover: ${p.reason}`,
  'toast.compactSkipped': (p: Params) => `⟲ Note written, but compaction was skipped: ${p.reason}`,
  'toast.done': (p: Params) => `⟲ Handed over and compacted: ${p.percent}%${p.after}, note ${p.file}`,
  'toast.noteWritten': (p: Params) => `⟲ Handover note written: ${p.file}`,
  // failure reasons
  'fail.nothingToFork': 'nothing to hand over yet',
  'fail.apiError': (p: Params) => `could not write the note: API error (${p.error}${p.status})`,
  'fail.emptyReply': 'could not write the note: the model returned no text',
  'fail.aborted': 'could not write the note: the request was interrupted',
  'fail.write': (p: Params) => `could not save the note: ${p.reason}`,
  'compactRejected': (p: Params) => `Note saved to ${p.file}, but compaction was refused (${p.reason}); retrying after the next turn ends`,
  // note headings (model-facing)
  'note.title': '# Handover note',
  'note.h1': '## Goal',
  'note.h2': '## Current state',
  'note.h3': '## Done',
  'note.h4': '## In progress',
  'note.h5': '## To do (by priority)',
  'note.h6': '## Key decisions and why',
  'note.h7': '## Important files and locations',
  'note.h8': '## Caveats / pitfalls',
  'note.h9': '## Next step (first thing)',
  // prompts (model-facing)
  'prompt.handover': (p: Params) =>
    [
      'Stop what you are doing and write a handover note for the next agent. They cannot see this conversation, only what you write, so make it enough to continue the work directly.',
      '',
      'Format: Markdown with exactly these headings, in this order, every one present (write "none" under a heading with nothing to say):',
      String(p.headings),
      '',
      'Rules:',
      '- Facts and decisions only; no pleasantries, do not restate this request.',
      '- Give full paths or names for files and functions; put commands in backticks.',
      '- "Next step" is one action, concrete enough to run as is.',
      '- At most 600 words in total.',
      '- Write the body in the language this conversation mostly uses; keep the headings as given.',
      '- Output the note only, with no preface or closing.',
    ].join('\n'),
  'prompt.compact':
    'Below is the handover note this session just wrote. When summarizing, keep its goal, current state, to-do list, key decisions, important files and next step verbatim (quoting is fine); do not drop or rewrite any path, name or number in it.',
  'inject.framing':
    '(auto-handover) This conversation wrote a handover note when context reached the threshold, then compacted. The full note follows; continue from it, and where it disagrees with the summary, the note wins.',
  'inject.file': (p: Params) => `(file: ${p.file})`,
  'resume.framing': (p: Params) =>
    `The previous session left a handover note for this project ${p.ago} ago (written by auto-handover, file: ${p.file}). Read it before starting; if the user's request is unrelated to it, ignore it.`,
} satisfies Record<string, Msg>

export type Messages = { [K in keyof typeof EN]: Msg }
export type MessageKey = keyof Messages

const ZH_TW: Messages = {
  'band.failure': p => `⟲ auto-handover：${p.reason}`,
  'band.writing': '⟲ 交接中：請模型寫筆記…',
  'band.compacting': '⟲ 交接中：筆記已寫好，compact…',
  'band.context': p => `⟲ context ${p.percent} / 門檻 ${p.threshold}%`,
  'band.paused': '已暫停',
  'band.last': p => `上次交接 ${p.ago} 前`,
  'status.head': p => `auto-handover：門檻 ${p.threshold}%，目前 context ${p.percent}${p.paused}`,
  'status.noReading': '尚無讀數',
  'status.pausedSuffix': '（已暫停）',
  'status.dir': p => `筆記目錄：${p.dir}`,
  'status.failure': p => `停用原因：${p.reason}`,
  'status.ready': '狀態：條件已滿足，下一個 turn 結束就會交接',
  'status.gate': p => `狀態：${p.reason}`,
  'status.last': p => `上次交接：${p.ago} 前（${p.trigger}，${p.percent}%${p.after}），${p.file}`,
  'status.lastNone': '上次交接：本 session 還沒有',
  'status.count': p => `本 session 交接 ${p.count} 次。/handover now 立即交接、/handover show 看最新筆記、/handover off 暫停。`,
  'gate.paused': '已用 /handover off 暫停',
  'gate.inFlight': '交接進行中',
  'gate.turnRunning': '有 turn 在跑，等它結束',
  'gate.noReading': '還沒有用量讀數',
  'gate.below': p => `用量 ${p.percent}% 未達門檻 ${p.threshold}%`,
  'gate.cooldown': p => `冷卻中（上次交接 ${p.ago} 前，冷卻 ${p.minutes} 分鐘）`,
  'dir.empty': 'handover_dir 是空的',
  'dir.badChars': 'handover_dir 含不合法字元',
  'dir.notAbsolute': p => `handover_dir 須為 ~/… 或絕對路徑（收到 ${p.value}）`,
  'dir.dotdot': 'handover_dir 不能含 ..',
  'dir.outsideHome': p => `handover_dir ${p.path} 不在家目錄底下，不寫任何檔案`,
  'home.unset': '讀不到家目錄（HOME 未設定），不寫任何檔案',
  'cmd.inFlight': 'auto-handover：交接進行中。',
  'cmd.nowTurnRunning': 'auto-handover：有 turn 在跑，等它結束就交接並 compact。',
  'cmd.nowScheduled': p => `auto-handover：約 ${p.seconds} 秒後開始交接（寫筆記 → compact → 筆記接回對話）。`,
  'cmd.off': 'auto-handover 已暫停：不再自動交接（/handover now 仍可手動）。/handover on 恢復。',
  'cmd.on': 'auto-handover 已恢復。',
  'cmd.noNote': 'auto-handover：還沒有交接筆記。',
  'cmd.unreadable': p => `auto-handover：讀不到 ${p.file}`,
  'cmd.usage': '用法：/handover（狀態）、/handover now（立即交接）、/handover show（看最新筆記）、/handover off|on',
  'toast.failed': p => `⟲ auto-handover：${p.reason}`,
  'toast.compactSkipped': p => `⟲ 筆記已寫好，但 compact 被略過：${p.reason}`,
  'toast.done': p => `⟲ 已交接並 compact：${p.percent}%${p.after}，筆記 ${p.file}`,
  'toast.noteWritten': p => `⟲ 已寫交接筆記：${p.file}`,
  'fail.nothingToFork': '對話還沒有內容可交接',
  'fail.apiError': p => `寫筆記失敗：API 錯誤（${p.error}${p.status}）`,
  'fail.emptyReply': '寫筆記失敗：模型沒有回文字',
  'fail.aborted': '寫筆記失敗：請求被中斷',
  'fail.write': p => `寫檔失敗：${p.reason}`,
  'compactRejected': p => `筆記已寫到 ${p.file}，但 compact 被拒（${p.reason}），下一個 turn 結束再試`,
  'note.title': '# 交接筆記',
  'note.h1': '## 目標',
  'note.h2': '## 目前狀態',
  'note.h3': '## 已完成',
  'note.h4': '## 進行中',
  'note.h5': '## 待辦（依優先順序）',
  'note.h6': '## 關鍵決策與原因',
  'note.h7': '## 重要檔案與位置',
  'note.h8': '## 注意事項 / 陷阱',
  'note.h9': '## 下一步（第一件事）',
  'prompt.handover': p =>
    [
      '請停下手邊的工作，為接手的下一位 agent 寫一份交接筆記。對方看不到這段對話，只會看到你寫的內容，所以要寫得能直接接手。',
      '',
      '格式：Markdown，依序使用下列標題，每個標題都要有（沒有內容就寫「無」）：',
      String(p.headings),
      '',
      '要求：',
      '- 只寫事實與決策，不要客套、不要重述這個指令。',
      '- 檔案與函式請寫完整路徑或名稱；指令請用反引號。',
      '- 「下一步」只寫一件事，具體到可以直接執行。',
      '- 全文不超過 600 字（或 600 words）。',
      '- 內文使用這段對話主要使用的語言；標題照上面給的寫。',
      '- 只輸出筆記本身，不要加前言或結語。',
    ].join('\n'),
  'prompt.compact':
    '以下是這個 session 剛寫好的交接筆記。摘要時請把筆記裡的目標、目前狀態、待辦、關鍵決策、重要檔案與下一步原封不動地保留下來（可以直接引用），不要省略或改寫其中的路徑、名稱與數字。',
  'inject.framing': '（auto-handover）這個對話剛才在 context 達到門檻時先寫了交接筆記再 compact。以下是筆記全文，請以它為準接續工作；若與摘要不一致，以筆記為準。',
  'inject.file': p => `（檔案：${p.file}）`,
  'resume.framing': p => `上一個 session 在 ${p.ago} 前為這個專案留下了交接筆記（auto-handover 寫的，檔案：${p.file}）。先讀它再開始；若使用者的要求與筆記無關，忽略即可。`,
}

const JA: Messages = {
  'band.failure': p => `⟲ auto-handover：${p.reason}`,
  'band.writing': '⟲ 引き継ぎ中：モデルにメモを書かせています…',
  'band.compacting': '⟲ 引き継ぎ中：メモ作成済み、compact 中…',
  'band.context': p => `⟲ context ${p.percent} / しきい値 ${p.threshold}%`,
  'band.paused': '一時停止中',
  'band.last': p => `前回の引き継ぎ ${p.ago} 前`,
  'status.head': p => `auto-handover：しきい値 ${p.threshold}%、現在の context ${p.percent}${p.paused}`,
  'status.noReading': '計測値なし',
  'status.pausedSuffix': '（一時停止中）',
  'status.dir': p => `メモの保存先：${p.dir}`,
  'status.failure': p => `無効化の理由：${p.reason}`,
  'status.ready': '状態：条件を満たしています。次の turn が終わり次第引き継ぎます',
  'status.gate': p => `状態：${p.reason}`,
  'status.last': p => `前回の引き継ぎ：${p.ago} 前（${p.trigger}、${p.percent}%${p.after}）、${p.file}`,
  'status.lastNone': '前回の引き継ぎ：この session ではまだありません',
  'status.count': p => `この session での引き継ぎは ${p.count} 回。/handover now で今すぐ引き継ぎ、/handover show で最新のメモ、/handover off で一時停止。`,
  'gate.paused': '/handover off で一時停止中',
  'gate.inFlight': '引き継ぎを実行中',
  'gate.turnRunning': 'turn の実行中。終了を待っています',
  'gate.noReading': '使用量の計測値がまだありません',
  'gate.below': p => `使用量 ${p.percent}% はしきい値 ${p.threshold}% 未満`,
  'gate.cooldown': p => `クールダウン中（前回の引き継ぎ ${p.ago} 前、クールダウン ${p.minutes} 分）`,
  'dir.empty': 'handover_dir が空です',
  'dir.badChars': 'handover_dir に不正な文字が含まれています',
  'dir.notAbsolute': p => `handover_dir は ~/… または絶対パスで指定してください（指定値：${p.value}）`,
  'dir.dotdot': 'handover_dir に .. は使えません',
  'dir.outsideHome': p => `handover_dir ${p.path} はホームディレクトリの外です。何も書き込みません`,
  'home.unset': 'ホームディレクトリが分かりません（HOME 未設定）。何も書き込みません',
  'cmd.inFlight': 'auto-handover：引き継ぎを実行中です。',
  'cmd.nowTurnRunning': 'auto-handover：turn の実行中です。終了後に引き継ぎと compact を行います。',
  'cmd.nowScheduled': p => `auto-handover：約 ${p.seconds} 秒後に引き継ぎを開始します（メモ作成 → compact → メモを会話に戻す）。`,
  'cmd.off': 'auto-handover を一時停止しました：自動引き継ぎは行いません（/handover now は使えます）。/handover on で再開。',
  'cmd.on': 'auto-handover を再開しました。',
  'cmd.noNote': 'auto-handover：引き継ぎメモはまだありません。',
  'cmd.unreadable': p => `auto-handover：${p.file} を読めません`,
  'cmd.usage': '使い方：/handover（状態）、/handover now（今すぐ引き継ぎ）、/handover show（最新のメモ）、/handover off|on',
  'toast.failed': p => `⟲ auto-handover：${p.reason}`,
  'toast.compactSkipped': p => `⟲ メモは作成しましたが compact はスキップされました：${p.reason}`,
  'toast.done': p => `⟲ 引き継ぎと compact が完了：${p.percent}%${p.after}、メモ ${p.file}`,
  'toast.noteWritten': p => `⟲ 引き継ぎメモを作成しました：${p.file}`,
  'fail.nothingToFork': '引き継ぐ内容がまだありません',
  'fail.apiError': p => `メモの作成に失敗：API エラー（${p.error}${p.status}）`,
  'fail.emptyReply': 'メモの作成に失敗：モデルがテキストを返しませんでした',
  'fail.aborted': 'メモの作成に失敗：リクエストが中断されました',
  'fail.write': p => `メモの保存に失敗：${p.reason}`,
  'compactRejected': p => `メモは ${p.file} に保存しましたが compact は拒否されました（${p.reason}）。次の turn 終了後に再試行します`,
  'note.title': '# 引き継ぎメモ',
  'note.h1': '## 目的',
  'note.h2': '## 現状',
  'note.h3': '## 完了したこと',
  'note.h4': '## 進行中',
  'note.h5': '## やること（優先順）',
  'note.h6': '## 重要な判断と理由',
  'note.h7': '## 重要なファイルと場所',
  'note.h8': '## 注意点・落とし穴',
  'note.h9': '## 次の一手',
  'prompt.handover': p =>
    [
      '作業を止めて、次に引き継ぐ agent のための引き継ぎメモを書いてください。相手はこの会話を見られず、あなたが書いた内容だけを読むので、そのまま作業を続けられるように書いてください。',
      '',
      '形式：Markdown。次の見出しをこの順番で必ずすべて使うこと（書くことがなければ「なし」と書く）：',
      String(p.headings),
      '',
      '条件：',
      '- 事実と判断だけを書く。前置きや、この指示の繰り返しは不要。',
      '- ファイルや関数はフルパスか正式な名前で書き、コマンドはバッククォートで囲む。',
      '- 「次の一手」は一つだけ、そのまま実行できる具体さで書く。',
      '- 全体で 600 語以内。',
      '- 本文はこの会話で主に使われている言語で書き、見出しは上記のとおりにする。',
      '- メモ本体だけを出力し、前書きや結びは付けない。',
    ].join('\n'),
  'prompt.compact':
    '以下は、この session が今書いた引き継ぎメモです。要約する際は、メモにある目的・現状・やること・重要な判断・重要なファイル・次の一手をそのまま残してください（引用して構いません）。パス・名前・数値を省略したり書き換えたりしないでください。',
  'inject.framing': '（auto-handover）この会話は context がしきい値に達したため、引き継ぎメモを書いてから compact しました。以下がメモの全文です。これを基準に作業を続け、要約と食い違う場合はメモを優先してください。',
  'inject.file': p => `（ファイル：${p.file}）`,
  'resume.framing': p => `前の session が ${p.ago} 前にこのプロジェクトの引き継ぎメモを残しています（auto-handover が作成、ファイル：${p.file}）。まず読んでから始めてください。ユーザーの依頼がメモと無関係なら無視して構いません。`,
}

export const MESSAGES: Record<Lang, Messages> = { en: EN, 'zh-TW': ZH_TW, ja: JA }

/** One message in `lang`, falling back to English when the key is missing there. */
export function t(lang: Lang, key: MessageKey, params?: Params): string {
  const m: Msg | undefined = MESSAGES[lang]?.[key] ?? EN[key]
  if (m === undefined) return key
  return typeof m === 'function' ? m(params ?? {}) : m
}
