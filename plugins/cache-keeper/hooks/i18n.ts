// cache-keeper UI strings in English, Traditional Chinese and Japanese.
// Pure: no `$`. The language is resolved once at session.start (see register.tsx)
// and passed into every text function in logic.ts.

export type Lang = 'en' | 'zh-TW' | 'ja'
export const LANGS: readonly Lang[] = ['en', 'zh-TW', 'ja']
export const DEFAULT_LANG: Lang = 'en'

export type Params = Record<string, string | number>
type Msg = string | ((p: Params) => string)

export type Messages = {
  'band.warm': Msg
  'band.next': Msg
  'band.pokes': Msg
  'band.lastHit': Msg
  'band.backoff': Msg
  'band.poking': Msg
  'band.capped': Msg
  'countdown.under1m': Msg
  'status.enabled': Msg
  'status.disabled': Msg
  'status.paused': Msg
  'status.interval': Msg
  'status.noCap': Msg
  'status.noRequest': Msg
  'status.capped': Msg
  'status.next': Msg
  'status.counts': Msg
  'status.lastHit': Msg
  'poke.miss': Msg
  'poke.hit': Msg
  'poke.busy': Msg
  'poke.nothing': Msg
  'poke.failed': Msg
  'poke.apiError': Msg
  'toast.failed': Msg
  'log.cap': Msg
  'log.miss': Msg
  'cmd.off': Msg
  'cmd.on': Msg
  'cmd.disabled': Msg
  'cmd.turnRunning': Msg
  'cmd.result': Msg
  'cmd.usage': Msg
}
export type MessageKey = keyof Messages

const en: Messages = {
  'band.warm': '♨ cache warm',
  'band.next': p => `next in ${p.t}`,
  'band.pokes': p => `${p.n} ${p.n === 1 ? 'poke' : 'pokes'}`,
  'band.lastHit': p => `last hit ${p.tok} tok`,
  'band.backoff': p => `backing off (${p.n} failed)`,
  'band.poking': '♨ warming…',
  'band.capped': p => `♨ idle for ${p.d}, warming stopped (/cache-keeper now to poke by hand)`,
  'countdown.under1m': 'under 1m',
  'status.enabled': 'cache-keeper: on',
  'status.disabled': 'cache-keeper: disabled (enabled is false in settings)',
  'status.paused': 'cache-keeper: paused (/cache-keeper on to resume)',
  'status.interval': p => `interval ${p.interval}; idle cap ${p.cap}`,
  'status.noCap': 'none',
  'status.noRequest': 'no model request yet; the countdown starts after the first turn ends',
  'status.capped': 'idle cap reached, automatic warming stopped; /cache-keeper now pokes once by hand',
  'status.next': p => `last request ${p.ago} ago; next poke in ${p.next}`,
  'status.counts': p => `${p.pokes} pokes, ${p.failures} failed`,
  'status.lastHit': p => `; last hit ${p.hit} tok (missed ${p.miss} tok)`,
  'poke.miss': p => `cache miss (entry probably expired), rewrote ${p.tok} tok`,
  'poke.hit': p => `cache hit ${p.hit} tok, missed ${p.miss} tok`,
  'poke.busy': 'already warming',
  'poke.nothing': 'nothing to warm yet (no reply in this conversation)',
  'poke.failed': p => `poke failed: ${p.why}`,
  'poke.apiError': p => `API error${p.status ? ` ${p.status}` : ''} (${p.error})`,
  'toast.failed': p => `cache-keeper: poke failed (${p.why}), will retry later`,
  'log.cap': 'cache-keeper: idle cap reached, warming stopped; /cache-keeper now pokes by hand',
  'log.miss': 'cache-keeper: that poke missed the cache (entry probably expired); the prefix was rewritten',
  'cmd.off': 'cache-keeper paused: no more pokes in this session. /cache-keeper on to resume.',
  'cmd.on': 'cache-keeper resumed.',
  'cmd.disabled': 'cache-keeper is disabled in settings; not poking.',
  'cmd.turnRunning': 'A turn is running; not poking (the turn itself refreshes the cache).',
  'cmd.result': p => `cache-keeper: ${p.text}`,
  'cmd.usage': 'Usage: /cache-keeper (status), /cache-keeper now (poke now), /cache-keeper off / on (pause / resume)',
}

const zhTW: Messages = {
  'band.warm': '♨ cache 保溫',
  'band.next': p => `下次 ${p.t} 後`,
  'band.pokes': p => `已戳 ${p.n} 次`,
  'band.lastHit': p => `上次命中 ${p.tok} tok`,
  'band.backoff': p => `退避中（失敗 ${p.n} 次）`,
  'band.poking': '♨ 保溫中…',
  'band.capped': p => `♨ 已閒置 ${p.d}，停止保溫（/cache-keeper now 可手動）`,
  'countdown.under1m': '不到 1m',
  'status.enabled': 'cache-keeper：啟用中',
  'status.disabled': 'cache-keeper：已停用（設定 enabled 為 false）',
  'status.paused': 'cache-keeper：已暫停（/cache-keeper on 恢復）',
  'status.interval': p => `保溫間隔 ${p.interval}；閒置上限 ${p.cap}`,
  'status.noCap': '無',
  'status.noRequest': '還沒有任何模型請求，第一個 turn 結束後開始計時',
  'status.capped': '已達閒置上限，停止自動保溫；/cache-keeper now 可手動戳一次',
  'status.next': p => `上次請求 ${p.ago} 前；下次保溫 ${p.next} 後`,
  'status.counts': p => `已戳 ${p.pokes} 次，失敗 ${p.failures} 次`,
  'status.lastHit': p => `；上次命中 ${p.hit} tok（未命中 ${p.miss} tok）`,
  'poke.miss': p => `這次沒命中快取（可能已過期），已重新寫入 ${p.tok} tok`,
  'poke.hit': p => `快取命中 ${p.hit} tok，未命中 ${p.miss} tok`,
  'poke.busy': '已經在保溫中',
  'poke.nothing': '目前沒有可保溫的對話（還沒有任何回覆）',
  'poke.failed': p => `保溫失敗：${p.why}`,
  'poke.apiError': p => `API 錯誤${p.status ? ` ${p.status}` : ''}（${p.error}）`,
  'toast.failed': p => `cache-keeper：保溫失敗（${p.why}），稍後再試`,
  'log.cap': 'cache-keeper：已達閒置上限，停止保溫；/cache-keeper now 可手動',
  'log.miss': 'cache-keeper：這次沒命中快取（可能已過期），已重新寫入',
  'cmd.off': 'cache-keeper 已暫停（本 session 不再保溫）。/cache-keeper on 恢復。',
  'cmd.on': 'cache-keeper 已恢復。',
  'cmd.disabled': 'cache-keeper 已在設定中停用，不戳。',
  'cmd.turnRunning': '有 turn 進行中，不戳（它自己就會刷新快取）。',
  'cmd.result': p => `cache-keeper：${p.text}`,
  'cmd.usage': '用法：/cache-keeper（狀態）、/cache-keeper now（立刻戳）、/cache-keeper off / on（暫停／恢復）',
}

const ja: Messages = {
  'band.warm': '♨ キャッシュ保温',
  'band.next': p => `次は${p.t}後`,
  'band.pokes': p => `${p.n}回送信`,
  'band.lastHit': p => `前回ヒット ${p.tok} tok`,
  'band.backoff': p => `バックオフ中（失敗${p.n}回）`,
  'band.poking': '♨ 保温中…',
  'band.capped': p => `♨ ${p.d} アイドルのため停止（/cache-keeper now で手動送信）`,
  'countdown.under1m': '1m未満',
  'status.enabled': 'cache-keeper：有効',
  'status.disabled': 'cache-keeper：無効（設定の enabled が false）',
  'status.paused': 'cache-keeper：一時停止中（/cache-keeper on で再開）',
  'status.interval': p => `保温間隔 ${p.interval}；アイドル上限 ${p.cap}`,
  'status.noCap': 'なし',
  'status.noRequest': 'まだモデルへのリクエストがありません。最初のターン終了後にカウント開始',
  'status.capped': 'アイドル上限に達したため自動保温を停止。/cache-keeper now で手動送信できます',
  'status.next': p => `前回のリクエストは${p.ago}前；次の保温は${p.next}後`,
  'status.counts': p => `${p.pokes}回送信、失敗${p.failures}回`,
  'status.lastHit': p => `；前回ヒット ${p.hit} tok（ミス ${p.miss} tok）`,
  'poke.miss': p => `キャッシュミス（期限切れの可能性）、${p.tok} tok を再書き込み`,
  'poke.hit': p => `キャッシュヒット ${p.hit} tok、ミス ${p.miss} tok`,
  'poke.busy': 'すでに保温中です',
  'poke.nothing': '保温できる会話がまだありません（応答がまだありません）',
  'poke.failed': p => `保温失敗：${p.why}`,
  'poke.apiError': p => `APIエラー${p.status ? ` ${p.status}` : ''}（${p.error}）`,
  'toast.failed': p => `cache-keeper：保温に失敗（${p.why}）、後で再試行します`,
  'log.cap': 'cache-keeper：アイドル上限に達したため保温を停止。/cache-keeper now で手動送信',
  'log.miss': 'cache-keeper：キャッシュミス（期限切れの可能性）、プレフィックスを再書き込みしました',
  'cmd.off': 'cache-keeper を一時停止しました（このセッションでは保温しません）。/cache-keeper on で再開。',
  'cmd.on': 'cache-keeper を再開しました。',
  'cmd.disabled': 'cache-keeper は設定で無効です。送信しません。',
  'cmd.turnRunning': 'ターン実行中のため送信しません（ターン自体がキャッシュを更新します）。',
  'cmd.result': p => `cache-keeper：${p.text}`,
  'cmd.usage': '使い方：/cache-keeper（状態）、/cache-keeper now（今すぐ送信）、/cache-keeper off / on（一時停止／再開）',
}

export const MESSAGES: Record<Lang, Messages> = { en, 'zh-TW': zhTW, ja }

/** Looks up a message in `lang`, falling back to English. */
export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  const m: Msg = MESSAGES[lang]?.[key] ?? MESSAGES.en[key]
  return typeof m === 'function' ? m(params) : m
}

function fromLocale(value: string | undefined): Lang | null {
  const v = (value ?? '').trim()
  if (!v || v === 'C' || v === 'POSIX') return null
  if (/^zh/i.test(v)) return 'zh-TW'
  if (/^ja/i.test(v)) return 'ja'
  return 'en'
}

/**
 * The UI language: an explicit option wins; `auto` (or anything else) reads
 * LC_ALL, then LC_MESSAGES, then LANG; nothing usable means English.
 */
export function resolveLang(option: unknown, env: { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string }): Lang {
  if (option === 'en' || option === 'zh-TW' || option === 'ja') return option
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const found = fromLocale(v)
    if (found) return found
  }
  return DEFAULT_LANG
}
