// cache-keeper behaviour tests: `claude plugin test plugins/cache-keeper`
//
// The test's `on` sits beneath every plugin and plays the engine: the clock is mock.clock,
// and model requests (model.fork) are faked and counted here.

import { describe, expect, mock, test } from 'claude-code/testing'

import { LANGS, MESSAGES, resolveLang, t } from '../hooks/i18n'
import type { Lang, MessageKey } from '../hooks/i18n'
import {
  EMPTY_STATE,
  bandText,
  clampInterval,
  isCacheMiss,
  isDue,
  isPastIdleCap,
  nextBackoff,
  nextPokeAt,
  parseConfig,
  statusText,
} from '../hooks/logic'
import type { KeeperConfig, KeeperState } from '../hooks/logic'

const MIN = 60_000
const HOUR = 3_600_000
const T0 = 1_000_000

type ForkReply =
  | { kind: 'ok'; cacheRead?: number; input?: number }
  | { kind: 'api-error'; status?: number }
  | { kind: 'nothing-to-fork' }
  | { kind: 'empty-reply' }

type World = {
  clock: ReturnType<typeof mock.clock>
  reply: ForkReply
  forks: number
  toasts: string[]
  logs: string[]
  turns: number
}

function world(on: any, env: Record<string, string> = {}): World {
  const w: World = { clock: mock.clock(on, { now: T0 }), reply: { kind: 'ok' }, forks: 0, toasts: [], logs: [], turns: 0 }
  const value = (v: unknown) => ({ value: v })
  mock.env(on, env)
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e))
    return value(undefined)
  })
  on('ui.log', (_$: any, e: any) => {
    w.logs.push(String(e.text ?? e))
    return value(undefined)
  })
  on('model.fork', () => {
    w.forks += 1
    const r = w.reply
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (r.kind === 'ok') {
      return value({
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: r.input ?? 20, output_tokens: 1, cache_read_input_tokens: r.cacheRead ?? 98_000, cache_creation_input_tokens: 0 },
      })
    }
    if (r.kind === 'api-error') return value({ isAnswered: false, reason: 'api-error', status: r.status ?? 529, error: 'overloaded', usage: zero })
    if (r.kind === 'nothing-to-fork') return value({ isAnswered: false, reason: 'nothing-to-fork' })
    return value({ isAnswered: false, reason: 'empty-reply', usage: zero })
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  // The engine's own drawing: catches a plugin that answers next(e)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  return w
}

async function start($: any, w: World, isInteractive = true): Promise<void> {
  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive })
  await w.clock.settle()
}

async function turnStart($: any, w: World): Promise<string> {
  w.turns += 1
  const id = `t${w.turns}`
  await $.turn.start({ text: 'hi', turnId: id })
  await w.clock.settle()
  return id
}

async function turnComplete($: any, w: World, turnId: string): Promise<void> {
  await $.turn.complete({ answer: 'done', durationMs: 100, isAborted: false, turnId, reason: 'answer' })
  await w.clock.settle()
}

async function turn($: any, w: World): Promise<void> {
  const id = await turnStart($, w)
  await turnComplete($, w, id)
}

async function run($: any, w: World, args = ''): Promise<string> {
  const r: any = await $.command.run({ command: 'cache-keeper', args, origin: { kind: 'composer' } } as any)
  await w.clock.settle()
  return String(r?.text ?? '')
}

const BAND = { plugin: 'cache-keeper', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } } as const

async function bandTexts($: any, surface: 'terminal' | 'desktop' = 'terminal', props: object = {}): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface } as any)
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return found.map((t: any) => String(t.text ?? ''))
}

const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l))

const cfg = (over: Partial<KeeperConfig> = {}): KeeperConfig => ({ enabled: true, intervalMs: 50 * MIN, idleCapMs: 4 * HOUR, showBand: true, language: 'en', bandStyle: 'box', ...over })
const st = (over: Partial<KeeperState> = {}): KeeperState => ({ ...EMPTY_STATE, ...over })

// ── Pure functions ──────────────────────────────────────────────────────────

describe('logic', () => {
  test('clampInterval: held to 5-59 minutes, bad values fall back to the default', async () => {
    expect(clampInterval(50)).toBe(50)
    expect(clampInterval(90)).toBe(59)
    expect(clampInterval(1)).toBe(5)
    expect(clampInterval(NaN)).toBe(50)
  })

  test('parseConfig: defaults, numeric strings, idle cap 0 = none, raw language', async () => {
    const d = parseConfig(undefined)
    expect(d).toEqual({ enabled: true, intervalMs: 50 * MIN, idleCapMs: 4 * HOUR, showBand: true, language: undefined, bandStyle: 'box' })
    const c = parseConfig({ interval_minutes: '20', max_idle_hours: 0, enabled: 'false', show_band: false, language: 'ja', band_style: 'rule' })
    expect(c).toEqual({ enabled: false, intervalMs: 20 * MIN, idleCapMs: 0, showBand: false, language: 'ja', bandStyle: 'rule' })
    expect(parseConfig({ band_style: 'fancy' }).bandStyle).toBe('box')
    expect(parseConfig({ max_idle_hours: -3 }).idleCapMs).toBe(0)
  })

  test('nextPokeAt / isDue: one interval normally, the later of interval and backoff', async () => {
    expect(nextPokeAt(T0, null, 10 * MIN, 0)).toBe(T0 + 10 * MIN)
    expect(nextPokeAt(T0, T0 + 10 * MIN, 10 * MIN, MIN)).toBe(T0 + 11 * MIN)
    expect(nextPokeAt(T0, T0 - 5 * MIN, 10 * MIN, MIN)).toBe(T0 + 10 * MIN)
    expect(isDue(T0 + 9 * MIN, st({ lastRequestAt: T0 }), 10 * MIN)).toBe(false)
    expect(isDue(T0 + 10 * MIN, st({ lastRequestAt: T0 }), 10 * MIN)).toBe(true)
    expect(isDue(T0 + HOUR, st({ lastRequestAt: null }), 10 * MIN)).toBe(false)
  })

  test('isPastIdleCap: 0 means no cap, no turn yet means not past', async () => {
    expect(isPastIdleCap(T0, T0 + HOUR, HOUR)).toBe(true)
    expect(isPastIdleCap(T0, T0 + HOUR - 1, HOUR)).toBe(false)
    expect(isPastIdleCap(T0, T0 + 10 * HOUR, 0)).toBe(false)
    expect(isPastIdleCap(null, T0 + 10 * HOUR, HOUR)).toBe(false)
  })

  test('nextBackoff: 1m, 2m, 4m… up to one interval', async () => {
    expect(nextBackoff(0, 10 * MIN)).toBe(MIN)
    expect(nextBackoff(MIN, 10 * MIN)).toBe(2 * MIN)
    expect(nextBackoff(8 * MIN, 10 * MIN)).toBe(10 * MIN)
    expect(nextBackoff(10 * MIN, 10 * MIN)).toBe(10 * MIN)
  })

  test('isCacheMiss: under a quarter served from cache counts as a miss', async () => {
    expect(isCacheMiss({ input_tokens: 20, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 0 })).toBe(false)
    expect(isCacheMiss({ input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 98_000 })).toBe(true)
    expect(isCacheMiss({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(false)
  })

  test('bandText: every state, in English', async () => {
    const c = cfg({ intervalMs: 50 * MIN })
    expect(bandText(st(), c, T0, 'en')).toBe(null)
    expect(bandText(st({ lastRequestAt: T0 }), cfg({ showBand: false }), T0, 'en')).toBe(null)
    expect(bandText(st({ lastRequestAt: T0, isPaused: true }), c, T0, 'en')).toBe(null)
    expect(bandText(st({ lastRequestAt: T0, lastRealTurnAt: T0 }), c, T0 + 12 * MIN, 'en')).toBe('♨ cache warm · next in 38m')
    expect(bandText(st({ lastRequestAt: T0, lastRealTurnAt: T0, pokes: 3, lastCacheRead: 98_000 }), c, T0 + 12 * MIN, 'en')).toBe(
      '♨ cache warm · next in 38m · 3 pokes · last hit 98k tok',
    )
    expect(bandText(st({ lastRequestAt: T0, lastRealTurnAt: T0, pokes: 1 }), c, T0 + 50 * MIN, 'en')).toBe('♨ cache warm · next in under 1m · 1 poke')
    expect(bandText(st({ lastRequestAt: T0, isPoking: true }), c, T0, 'en')).toBe('♨ warming…')
    expect(bandText(st({ lastRequestAt: T0, lastRealTurnAt: T0 }), c, T0 + 4 * HOUR, 'en')).toMatch(/idle for 4h00m, warming stopped/)
    expect(bandText(st({ lastRequestAt: T0, lastRealTurnAt: T0, lastAttemptAt: T0 + 50 * MIN, backoffMs: MIN, failures: 1 }), c, T0 + 50 * MIN, 'en')).toMatch(/backing off \(1 failed\)/)
  })

  test('bandText / statusText: zh-TW and ja wording', async () => {
    const s = st({ lastRequestAt: T0, lastRealTurnAt: T0, pokes: 3, lastCacheRead: 98_000 })
    expect(bandText(s, cfg(), T0 + 12 * MIN, 'zh-TW')).toBe('♨ cache 保溫 · 下次 38m 後 · 已戳 3 次 · 上次命中 98k tok')
    expect(bandText(s, cfg(), T0 + 12 * MIN, 'ja')).toBe('♨ キャッシュ保温 · 次は38m後 · 3回送信 · 前回ヒット 98k tok')
    expect(bandText(st({ lastRequestAt: T0, lastRealTurnAt: T0 }), cfg(), T0 + 4 * HOUR, 'ja')).toMatch(/4h00m アイドルのため停止/)
    expect(statusText(s, cfg(), T0 + 10 * MIN, 'ja')).toMatch(/保温間隔 50m；アイドル上限 4h00m/)
    expect(statusText(s, cfg(), T0 + 10 * MIN, 'zh-TW')).toMatch(/下次保溫 40m 後/)
  })

  test('statusText: interval, cap, next poke, counters', async () => {
    const text = statusText(st({ lastRequestAt: T0, lastRealTurnAt: T0, pokes: 2, lastCacheRead: 5000, lastInput: 20 }), cfg(), T0 + 10 * MIN, 'en')
    expect(text).toMatch(/cache-keeper: on/)
    expect(text).toMatch(/interval 50m; idle cap 4h00m/)
    expect(text).toMatch(/next poke in 40m/)
    expect(text).toMatch(/2 pokes, 0 failed; last hit 5.0k tok \(missed 20 tok\)/)
    expect(statusText(st(), cfg({ enabled: false }), T0, 'en')).toMatch(/disabled/)
    expect(statusText(st(), cfg({ idleCapMs: 0 }), T0, 'en')).toMatch(/idle cap none/)
  })
})

describe('i18n', () => {
  test('resolveLang: explicit option wins, auto reads LC_ALL > LC_MESSAGES > LANG, C/POSIX/empty mean English', async () => {
    expect(resolveLang('ja', { LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('zh-TW', {})).toBe('zh-TW')
    expect(resolveLang('en', { LC_ALL: 'ja_JP.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: 'ja_JP.UTF-8', LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-TW')
    expect(resolveLang('auto', { LANG: 'ja' })).toBe('ja')
    expect(resolveLang('auto', { LANG: 'de_DE.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: 'C', LANG: 'ja_JP' })).toBe('ja')
    expect(resolveLang('auto', { LANG: 'POSIX' })).toBe('en')
    expect(resolveLang(undefined, {})).toBe('en')
    expect(resolveLang('fr', { LANG: 'ja_JP' })).toBe('ja')
  })

  test('every language has every message, and t() falls back to English', async () => {
    const keys = Object.keys(MESSAGES.en) as MessageKey[]
    for (const lang of LANGS) {
      for (const key of keys) {
        const m = MESSAGES[lang][key]
        expect(typeof m === 'string' || typeof m === 'function').toBe(true)
      }
      expect(Object.keys(MESSAGES[lang]).length).toBe(keys.length)
    }
    expect(t('xx' as Lang, 'band.warm')).toBe('♨ cache warm')
    expect(t('ja', 'band.pokes', { n: 2 })).toBe('2回送信')
  })
})

// ── Engine behaviour ────────────────────────────────────────────────────────

describe('cache-keeper', () => {
  test('no poke before the first turn', async ($, on) => {
    const w = world(on)
    await start($, w)
    await w.clock.advance(2 * HOUR)
    expect(w.forks).toBe(0)
  })

  test('a non-interactive session (-p) never pokes', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await turn($, w)
    await w.clock.advance(HOUR)
    expect(w.forks).toBe(0)
  })

  test('pokes once an interval after the turn ends, then every interval', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    await w.clock.advance(10 * MIN - 30_000)
    expect(w.forks).toBe(0)
    await w.clock.advance(30_000)
    expect(w.forks).toBe(1)
    await w.clock.advance(10 * MIN)
    expect(w.forks).toBe(2)
    expect(w.toasts).toEqual([])
  })

  test('no poke while a turn runs; the countdown restarts after it', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    const id = await turnStart($, w)
    await w.clock.advance(30 * MIN)
    expect(w.forks).toBe(0)
    await turnComplete($, w, id)
    await w.clock.advance(10 * MIN - 30_000)
    expect(w.forks).toBe(0)
    await w.clock.advance(30_000)
    expect(w.forks).toBe(1)
  })

  test("main's turn.step restarts the countdown; a subagent's does not", { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    const result = (e: any): any => ({ turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null })
    on('turn.step', async function* (_$: any, e: any): any {
      return result(e)
    })
    await start($, w)
    await turn($, w)
    // A subagent request at 5 minutes: no effect, the poke still lands at 10 minutes
    await w.clock.advance(5 * MIN)
    const sub: any = $.turn.step({ turnId: 'a1', index: 0, model: 'm', messageCount: 1, agentId: 'agent-1' } as any)
    for await (const _ of sub) void _
    await w.clock.settle()
    await w.clock.advance(5 * MIN)
    expect(w.forks).toBe(1)
    // A main request at 15 minutes (mid-turn): after the turn ends, count from then
    const id = await turnStart($, w)
    await w.clock.advance(5 * MIN)
    const main: any = $.turn.step({ turnId: id, index: 0, model: 'm', messageCount: 1 } as any)
    for await (const _ of main) void _
    await w.clock.settle()
    await turnComplete($, w, id)
    await w.clock.advance(10 * MIN - 30_000)
    expect(w.forks).toBe(1)
    await w.clock.advance(30_000)
    expect(w.forks).toBe(2)
  })

  test('stops past the idle cap; /cache-keeper on does not resume automatic pokes, now still works', { options: { interval_minutes: 10, max_idle_hours: 1 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    await w.clock.advance(3 * HOUR)
    // one each at 10, 20, 30, 40, 50 minutes; the cap is reached at 60
    expect(w.forks).toBe(5)
    expect(w.logs.some(l => /idle cap reached/.test(l))).toBe(true)
    const text = await run($, w, 'now')
    expect(text).toMatch(/cache hit/)
    expect(w.forks).toBe(6)
  })

  test('failure backoff: 1m, 2m…, one toast on the first failure, reset after a success', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    w.reply = { kind: 'api-error' }
    await start($, w)
    await turn($, w)
    await w.clock.advance(10 * MIN)
    expect(w.forks).toBe(1)
    expect(w.toasts.length).toBe(1)
    expect(w.toasts[0]).toMatch(/poke failed \(API error 529 \(overloaded\)\)/)
    await w.clock.advance(MIN)
    expect(w.forks).toBe(2)
    await w.clock.advance(MIN)
    expect(w.forks).toBe(2)
    await w.clock.advance(MIN)
    expect(w.forks).toBe(3)
    expect(w.toasts.length).toBe(1)
    w.reply = { kind: 'ok' }
    await w.clock.advance(4 * MIN)
    expect(w.forks).toBe(4)
    // After a success the backoff is cleared: the next poke is a full interval away
    await w.clock.advance(10 * MIN - 30_000)
    expect(w.forks).toBe(4)
    await w.clock.advance(30_000)
    expect(w.forks).toBe(5)
  })

  test('nothing-to-fork: skipped quietly, not a failure, not retried', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    w.reply = { kind: 'nothing-to-fork' }
    await start($, w)
    await turn($, w)
    await w.clock.advance(HOUR)
    expect(w.forks).toBe(1)
    expect(w.toasts).toEqual([])
    expect(await run($, w)).toMatch(/no model request yet/)
  })

  test('/clear resets the countdown', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
    await w.clock.settle()
    await w.clock.advance(HOUR)
    expect(w.forks).toBe(0)
  })

  test('commands: status, off, on, now', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(await run($, w)).toMatch(/interval 10m/)
    await turn($, w)
    expect(await run($, w, 'off')).toMatch(/paused/)
    await w.clock.advance(HOUR)
    expect(w.forks).toBe(0)
    expect(await run($, w, 'on')).toMatch(/resumed/)
    await w.clock.advance(30_000)
    expect(w.forks).toBe(1)
    const id = await turnStart($, w)
    expect(await run($, w, 'now')).toMatch(/A turn is running/)
    expect(w.forks).toBe(1)
    await turnComplete($, w, id)
    expect(await run($, w, 'now')).toMatch(/cache hit 98k tok/)
    expect(w.forks).toBe(2)
    expect(await run($, w, 'wat')).toMatch(/Usage/)
  })

  test('enabled=false: never pokes', { options: { interval_minutes: 10, max_idle_hours: 0, enabled: false } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    await w.clock.advance(HOUR)
    expect(w.forks).toBe(0)
    expect(await run($, w, 'now')).toMatch(/disabled in settings/)
  })

  test('band: countdown, hidden while a turn runs, cap notice, drawn on both surfaces', { options: { interval_minutes: 10, max_idle_hours: 1 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(has(await bandTexts($, surface), /♨/)).toBe(false)
    }
    await turn($, w)
    await w.clock.advance(2 * MIN)
    for (const surface of ['terminal', 'desktop'] as const) {
      const lines = await bandTexts($, surface)
      expect(has(lines, /♨ cache warm · next in 8m/)).toBe(true)
      expect(has(lines, /ENGINE_DEFAULT/)).toBe(true)
    }
    expect(has(await bandTexts($, 'terminal', { isWorking: true }), /♨/)).toBe(false)
    expect(has(await bandTexts($, 'terminal', { hasSurvey: true }), /♨/)).toBe(false)
    await w.clock.advance(HOUR)
    expect(has(await bandTexts($), /warming stopped/)).toBe(true)
  })

  // The band's frame: a rounded box, dim normally and yellow while backing off after failures.
  async function frames($: any): Promise<{ boxes: any[]; texts: string[] }> {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    const boxes = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.borderStyle === 'round')
    const found = await ui.findAll({ type: 'Text' })
    await ui.unmount()
    return { boxes, texts: found.map((x: any) => String(x.text ?? '')) }
  }

  test('band_style=box (default): dim frame, no rule; yellow while backing off', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    let f = await frames($)
    expect(f.boxes.length).toBe(1)
    expect(f.boxes[0]?.props?.borderDimColor).toBe(true)
    expect(f.boxes[0]?.props?.borderColor).toBe(undefined)
    expect(has(f.texts, /^─+$/)).toBe(false)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
    w.reply = { kind: 'api-error' }
    await w.clock.advance(10 * MIN)
    f = await frames($)
    expect(has(f.texts, /backing off/)).toBe(true)
    expect(f.boxes[0]?.props?.borderColor).toBe('yellow')
    expect(f.boxes[0]?.props?.borderDimColor).toBe(undefined)
  })

  test('band_style=rule draws the thin line beneath when a plugin is below', { options: { interval_minutes: 10, band_style: 'rule' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    const f = await frames($)
    expect(f.boxes.length).toBe(0)
    expect(has(f.texts, /^─+$/)).toBe(true)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
  })

  test('band_style=plain draws neither frame nor rule', { options: { interval_minutes: 10, band_style: 'plain' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    const f = await frames($)
    expect(f.boxes.length).toBe(0)
    expect(has(f.texts, /^─+$/)).toBe(false)
    expect(has(f.texts, /♨ cache warm/)).toBe(true)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
  })

  test('band: show_band=false takes no line', { options: { interval_minutes: 10, show_band: false } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await turn($, w)
    const lines = await bandTexts($)
    expect(has(lines, /♨/)).toBe(false)
    expect(has(lines, /ENGINE_DEFAULT/)).toBe(true)
  })

  test('language=ja: band, status and commands in Japanese', { options: { interval_minutes: 10, max_idle_hours: 0, language: 'ja' } }, async ($, on) => {
    const w = world(on, { LANG: 'en_US.UTF-8' })
    await start($, w)
    expect(await run($, w)).toMatch(/cache-keeper：有効/)
    await turn($, w)
    await w.clock.advance(2 * MIN)
    expect(has(await bandTexts($), /♨ キャッシュ保温 · 次は8m後/)).toBe(true)
    expect(await run($, w, 'off')).toMatch(/一時停止/)
    expect(await run($, w, 'on')).toMatch(/再開/)
    expect(await run($, w, 'now')).toMatch(/キャッシュヒット 98k tok/)
  })

  test('language=auto follows LANG=zh_TW.UTF-8', { options: { interval_minutes: 10, max_idle_hours: 0, language: 'auto' } }, async ($, on) => {
    const w = world(on, { LANG: 'zh_TW.UTF-8' })
    await start($, w)
    await turn($, w)
    await w.clock.advance(2 * MIN)
    expect(has(await bandTexts($), /♨ cache 保溫 · 下次 8m 後/)).toBe(true)
    expect(await run($, w)).toMatch(/啟用中/)
  })

  test('language=auto with no locale is English', { options: { interval_minutes: 10, max_idle_hours: 0 } }, async ($, on) => {
    const w = world(on, {})
    await start($, w)
    await turn($, w)
    await w.clock.advance(2 * MIN)
    expect(has(await bandTexts($), /♨ cache warm · next in 8m/)).toBe(true)
  })
})
