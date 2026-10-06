// secret-guard i18n: the UI language, how it is resolved, and every string a person
// reads, in English, Traditional Chinese and Japanese.
// Pure: no `$`. Shared with logic.ts, register.tsx and the tests.
//
// The placeholders that replace a secret (`<google api key>`, `<private key>`, ...)
// are NOT translated: the model reads them, and they must look the same in every
// language so a placeholder is never mistaken for a value.

export type Lang = 'en' | 'zh-TW' | 'ja'
export const LANGS: readonly Lang[] = ['en', 'zh-TW', 'ja']
export const DEFAULT_LANG: Lang = 'en'

export type LangEnv = { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string }

/**
 * Picks the language: an explicit option (`en`, `zh-TW`, `ja`) wins; `auto`,
 * undefined or anything else reads LC_ALL, then LC_MESSAGES, then LANG.
 * Any `zh*` locale maps to zh-TW (only Traditional is shipped), `ja*` to ja,
 * everything else (including C, POSIX and empty) to en.
 */
export function resolveLang(option: unknown, env: LangEnv): Lang {
  if (option === 'en' || option === 'zh-TW' || option === 'ja') return option
  for (const raw of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const v = (raw ?? '').trim()
    if (!v) continue
    const low = v.toLowerCase()
    if (low === 'c' || low === 'posix') return 'en'
    if (low.startsWith('zh')) return 'zh-TW'
    if (low.startsWith('ja')) return 'ja'
    return 'en'
  }
  return DEFAULT_LANG
}

export type Params = Record<string, string | number>
type Message = string | ((p: Params) => string)

const en = {
  // toast
  'toast.redacted': (p: Params) => `secret-guard: redacted ${p.n} (${p.labels})`,
  'toast.redactedWhere': (p: Params) => `secret-guard: redacted ${p.n} (${p.labels}) in ${p.where}`,
  // band
  'band.summary': (p: Params) => `🛡 secret-guard · ${p.n} redacted this session · last: ${p.last}`,
  'band.paused': '🛡 secret-guard · paused (/secret-guard on resumes)',
  'band.badPatterns': (p: Params) => `🛡 secret-guard · ${p.n} invalid custom pattern(s) ignored: ${p.names}`,
  // where the text came in
  'where.prompt': 'prompt',
  'where.command': 'command',
  'where.context': 'context',
  'where.attachment': 'attachment',
  'where.tool-result': 'tool result',
  'where.tool-message': 'tool message',
  'where.delivery': 'delivery',
  'where.hook-context': 'hook context',
  'where.note': 'note',
  'where.compaction': 'compaction',
  'where.agent': (p: Params) => `${p.where}, agent ${p.id}`,
  // command
  'cmd.description': 'Secret redaction status; log lists every hit by fingerprint; clear empties it; off / on pause or resume for this session; test runs the detectors over a built-in sample',
  'cmd.status.enabled': 'secret-guard: enabled',
  'cmd.status.paused': 'secret-guard: paused for this session (/secret-guard on resumes)',
  'cmd.status.disabled': 'secret-guard: disabled in settings (enabled = false)',
  'cmd.status.total': (p: Params) => `redacted this session: ${p.n}`,
  'cmd.status.byLabel': 'by label:',
  'cmd.status.recent': 'most recent:',
  'cmd.status.none': 'nothing redacted yet',
  'cmd.status.scope': (p: Params) => `scanning: ${p.scope}`,
  'cmd.scope.all': 'prompts, context, attachments and tool results',
  'cmd.scope.promptsOnly': 'prompts and context only (scan_tool_results is off)',
  'cmd.status.badPatterns': (p: Params) => `invalid custom patterns ignored: ${p.names}`,
  'cmd.off': 'secret-guard paused: nothing is redacted until /secret-guard on.',
  'cmd.on': 'secret-guard resumed.',
  'cmd.test.header': 'secret-guard self-test over a built-in sample of fake values:',
  'cmd.test.fired': (p: Params) => `  ✓ ${p.label} × ${p.n}`,
  'cmd.test.summary': (p: Params) => `${p.n} detector(s) fired, ${p.left} placeholder(s) in the result.`,
  'cmd.usage': 'Usage: /secret-guard (status), /secret-guard log (every hit, by fingerprint), /secret-guard clear (forget them), /secret-guard off | on (pause / resume), /secret-guard test (self-test)',
  'ago': (p: Params) => `${p.d} ago`,
  'cmd.status.more': (p: Params) => `  … ${p.n} more (/secret-guard log lists all)`,
  'cmd.hit.agent': (p: Params) => `[agent ${p.id}]`,
  'cmd.log.header': (p: Params) => `secret-guard: ${p.n} hit(s) this session, ${p.groups} distinct value(s) (fingerprints are this session's only):`,
  'cmd.cleared': 'secret-guard: the hit list and the counters for this session are cleared.',
} as const

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, Message>

const zhTW: Messages = {
  'toast.redacted': p => `secret-guard：已遮蔽 ${p.n} 處（${p.labels}）`,
  'toast.redactedWhere': p => `secret-guard：已遮蔽 ${p.n} 處（${p.labels}），來源 ${p.where}`,
  'band.summary': p => `🛡 secret-guard · 本 session 已遮蔽 ${p.n} 處 · 最近：${p.last}`,
  'band.paused': '🛡 secret-guard · 已暫停（/secret-guard on 恢復）',
  'band.badPatterns': p => `🛡 secret-guard · ${p.n} 條自訂規則無法編譯，已略過：${p.names}`,
  'where.prompt': '提示',
  'where.command': '指令',
  'where.context': 'context',
  'where.attachment': '附件',
  'where.tool-result': '工具結果',
  'where.tool-message': '工具訊息',
  'where.delivery': '外部訊息',
  'where.hook-context': 'hook context',
  'where.note': '註記',
  'where.compaction': 'compaction',
  'where.agent': p => `${p.where}，agent ${p.id}`,
  'cmd.description': '機敏資料遮蔽狀態；log 依指紋列出每一筆；clear 清除紀錄；off / on 暫停或恢復本 session；test 用內建假資料跑一次偵測',
  'cmd.status.enabled': 'secret-guard：啟用中',
  'cmd.status.paused': 'secret-guard：本 session 已暫停（/secret-guard on 恢復）',
  'cmd.status.disabled': 'secret-guard：已在設定中停用（enabled = false）',
  'cmd.status.total': p => `本 session 已遮蔽：${p.n} 處`,
  'cmd.status.byLabel': '依類型：',
  'cmd.status.recent': '最近：',
  'cmd.status.none': '還沒有遮蔽任何東西',
  'cmd.status.scope': p => `掃描範圍：${p.scope}`,
  'cmd.scope.all': '提示、context、附件與工具結果',
  'cmd.scope.promptsOnly': '只掃提示與 context（scan_tool_results 已關）',
  'cmd.status.badPatterns': p => `無法編譯的自訂規則已略過：${p.names}`,
  'cmd.off': 'secret-guard 已暫停：到 /secret-guard on 之前不遮蔽任何東西。',
  'cmd.on': 'secret-guard 已恢復。',
  'cmd.test.header': 'secret-guard 自我測試（內建假資料）：',
  'cmd.test.fired': p => `  ✓ ${p.label} × ${p.n}`,
  'cmd.test.summary': p => `${p.n} 個偵測器觸發，結果中有 ${p.left} 個 placeholder。`,
  'cmd.usage': '用法：/secret-guard（狀態）、/secret-guard log（依指紋列出每一筆）、/secret-guard clear（清除紀錄）、/secret-guard off | on（暫停／恢復）、/secret-guard test（自我測試）',
  'ago': p => `${p.d} 前`,
  'cmd.status.more': p => `  … 還有 ${p.n} 筆（/secret-guard log 列出全部）`,
  'cmd.hit.agent': p => `[agent ${p.id}]`,
  'cmd.log.header': p => `secret-guard：本 session 共 ${p.n} 筆，${p.groups} 個不同的值（指紋只在本 session 有效）：`,
  'cmd.cleared': 'secret-guard：本 session 的紀錄與計數已清除。',
}

const ja: Messages = {
  'toast.redacted': p => `secret-guard：${p.n} 件を伏せました（${p.labels}）`,
  'toast.redactedWhere': p => `secret-guard：${p.n} 件を伏せました（${p.labels}）、${p.where}`,
  'band.summary': p => `🛡 secret-guard · このセッションで ${p.n} 件伏せました · 直近：${p.last}`,
  'band.paused': '🛡 secret-guard · 一時停止中（/secret-guard on で再開）',
  'band.badPatterns': p => `🛡 secret-guard · カスタムパターン ${p.n} 件が無効のため無視：${p.names}`,
  'where.prompt': 'プロンプト',
  'where.command': 'コマンド',
  'where.context': 'コンテキスト',
  'where.attachment': '添付',
  'where.tool-result': 'ツール結果',
  'where.tool-message': 'ツールメッセージ',
  'where.delivery': '外部メッセージ',
  'where.hook-context': 'hook コンテキスト',
  'where.note': 'ノート',
  'where.compaction': 'compaction',
  'where.agent': p => `${p.where}、agent ${p.id}`,
  'cmd.description': '秘密情報の伏せ字の状態；log は指紋ごとに全件を表示；clear で記録を消去；off / on でこのセッションの一時停止・再開；test は内蔵サンプルで検出器を試す',
  'cmd.status.enabled': 'secret-guard：有効',
  'cmd.status.paused': 'secret-guard：このセッションでは一時停止中（/secret-guard on で再開）',
  'cmd.status.disabled': 'secret-guard：設定で無効（enabled = false）',
  'cmd.status.total': p => `このセッションで伏せた件数：${p.n}`,
  'cmd.status.byLabel': '種類別：',
  'cmd.status.recent': '直近：',
  'cmd.status.none': 'まだ何も伏せていません',
  'cmd.status.scope': p => `対象：${p.scope}`,
  'cmd.scope.all': 'プロンプト、コンテキスト、添付、ツール結果',
  'cmd.scope.promptsOnly': 'プロンプトとコンテキストのみ（scan_tool_results はオフ）',
  'cmd.status.badPatterns': p => `無効なカスタムパターンを無視：${p.names}`,
  'cmd.off': 'secret-guard を一時停止しました：/secret-guard on まで何も伏せません。',
  'cmd.on': 'secret-guard を再開しました。',
  'cmd.test.header': 'secret-guard セルフテスト（内蔵のダミー値）：',
  'cmd.test.fired': p => `  ✓ ${p.label} × ${p.n}`,
  'cmd.test.summary': p => `${p.n} 個の検出器が反応し、結果に ${p.left} 個のプレースホルダーがあります。`,
  'cmd.usage': '使い方：/secret-guard（状態）、/secret-guard log（指紋ごとに全件）、/secret-guard clear（記録を消去）、/secret-guard off | on（一時停止／再開）、/secret-guard test（セルフテスト）',
  'ago': p => `${p.d}前`,
  'cmd.status.more': p => `  … ほか ${p.n} 件（/secret-guard log で全件）`,
  'cmd.hit.agent': p => `[agent ${p.id}]`,
  'cmd.log.header': p => `secret-guard：このセッションで ${p.n} 件、異なる値は ${p.groups} 個（指紋はこのセッション内でのみ有効）：`,
  'cmd.cleared': 'secret-guard：このセッションの記録とカウントを消去しました。',
}

export const MESSAGES: Record<Lang, Messages> = { en: en as Messages, 'zh-TW': zhTW, ja }

/** Looks a message up; a key missing in a language falls back to English. */
export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  const m = MESSAGES[lang][key] ?? MESSAGES.en[key]
  return typeof m === 'function' ? m(params) : m
}
