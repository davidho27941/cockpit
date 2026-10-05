// cache-keeper: while a session idles, periodically send one tiny request over the
// conversation prefix so the prompt cache does not lapse.
//
// - The cache lives one hour past its last use. Once the session has idled for one
//   interval (default 50 minutes) we run `$.model.fork` with a one-word prompt: a fork
//   re-sends the main loop's last request prefix, the API serves it from cache, and the
//   entry's timer resets.
// - Only while idle: never during a turn, every real request restarts the countdown, and
//   we stop past the idle cap.
// - Failures back off: 1m, 2m, 4m… up to one interval; `nothing-to-fork` (no reply yet)
//   is skipped quietly.
// - No files, no shell, no network: the one outward action is that model request, made
//   through the session's own client.
// - UI language: the `language` option, or `auto` from LC_ALL / LC_MESSAGES / LANG.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { DEFAULT_LANG, resolveLang, t } from './i18n'
import type { Lang } from './i18n'
import {
  EMPTY_STATE,
  POKE_PROMPT,
  TICK_MS,
  TOAST_MS,
  bandText,
  isCacheMiss,
  isDue,
  isPastIdleCap,
  nextBackoff,
  parseConfig,
  pokeText,
  statusText,
} from './logic'
import type { BandStyle, KeeperConfig, KeeperState } from './logic'

const state = atom({ plugin: 'cache-keeper', key: 'state' } as const, EMPTY_STATE)
const tickAt = atom({ plugin: 'cache-keeper', key: 'tickAt' } as const, 0)
const langState = atom({ plugin: 'cache-keeper', key: 'lang' } as const, DEFAULT_LANG)

// Module-level: reset on hot reload. `register` re-reads the config; `inFlight` keeps one
// environment from poking twice at once.
let config: KeeperConfig = parseConfig(undefined)
let lang: Lang = DEFAULT_LANG
let inFlight = false

function toast($: any, text: string): void {
  try {
    $.ui.toast(text, { timeoutMs: TOAST_MS })
  } catch {}
}

function log($: any, text: string, toDebug = true): void {
  try {
    $.ui.log(text, toDebug ? { to: 'debug' } : undefined)
  } catch {}
}

async function patch($: any, fn: (s: KeeperState) => Partial<KeeperState>): Promise<void> {
  await update($, state, s => ({ ...s, ...fn(s) }))
}

type PokeOutcome = { ok: true; text: string } | { ok: false; text: string }

/** One poke. Returns the text shown by /cache-keeper now. */
async function poke($: any, origin: 'timer' | 'command'): Promise<PokeOutcome> {
  if (inFlight) return { ok: false, text: t(lang, 'poke.busy') }
  inFlight = true
  const startedAt: number = await $.clock.now()
  await patch($, () => ({ isPoking: true, lastAttemptAt: startedAt }))
  try {
    let r: any
    try {
      r = await $.model.fork({ prompt: POKE_PROMPT })
    } catch (err) {
      r = { isAnswered: false, reason: 'rejected', error: String(err) }
    }
    if (r?.isAnswered) {
      const u = r.usage
      const text = pokeText(u, lang)
      // The cache lifetime counts from the request's start, so that is the time we record
      await patch($, s => ({
        lastRequestAt: startedAt,
        pokes: s.pokes + 1,
        lastCacheRead: u.cache_read_input_tokens,
        lastInput: u.input_tokens + u.cache_creation_input_tokens,
        backoffMs: 0,
      }))
      log($, `cache-keeper: ${origin} poke: ${text}`)
      if (isCacheMiss(u) && origin === 'timer') log($, t(lang, 'log.miss'), false)
      return { ok: true, text }
    }
    if (r?.reason === 'nothing-to-fork') {
      // No reply yet (new session or right after /clear): nothing to warm, wait for a turn
      await patch($, () => ({ lastRequestAt: null }))
      return { ok: false, text: t(lang, 'poke.nothing') }
    }
    const why = r?.reason === 'api-error' ? t(lang, 'poke.apiError', { status: r.status ?? '', error: String(r.error) }) : String(r?.reason ?? 'unknown')
    let firstFailure = false
    await patch($, s => {
      firstFailure = s.failures === 0
      return { failures: s.failures + 1, backoffMs: nextBackoff(s.backoffMs, config.intervalMs) }
    })
    log($, `cache-keeper: poke failed: ${why}`)
    if (firstFailure && origin === 'timer') toast($, t(lang, 'toast.failed', { why }))
    return { ok: false, text: t(lang, 'poke.failed', { why }) }
  } finally {
    inFlight = false
    await patch($, () => ({ isPoking: false }))
  }
}

async function onTick($: any): Promise<void> {
  const s = await read($, state)
  if (!config.enabled || s.isPaused || s.lastRequestAt === null) return
  const now: number = await $.clock.now()
  if (config.showBand) await update($, tickAt, () => now)
  if (s.isTurnRunning || s.isPoking || inFlight) return
  if (isPastIdleCap(s.lastRealTurnAt, now, config.idleCapMs)) {
    if (!s.isCapNoticed) {
      await patch($, () => ({ isCapNoticed: true }))
      log($, t(lang, 'log.cap'), false)
    }
    return
  }
  if (isDue(now, s, config.intervalMs)) await poke($, 'timer')
}

async function resolveLanguage($: any): Promise<Lang> {
  const env: { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string } = {}
  try {
    env.LC_ALL = await $.env.get('LC_ALL')
    env.LC_MESSAGES = await $.env.get('LC_MESSAGES')
    env.LANG = await $.env.get('LANG')
  } catch {}
  return resolveLang(config.language, env)
}

async function onSessionStart($: any, e: any, next: any) {
  const out = await next(e)
  lang = await resolveLanguage($)
  await update($, langState, () => lang)
  await $.command.register({
    name: 'cache-keeper',
    description: 'Prompt cache warming: show status; /cache-keeper now pokes once, off pauses, on resumes',
    argumentHint: '[now|off|on]',
  })
  // A hot reload can leave isPoking stuck (the promise is gone): clear it. isTurnRunning stays; turn.complete ends it.
  await patch($, () => ({ isPoking: false }))
  // Nobody is waiting in `claude -p` or an SDK session: no warming there
  if (e.isInteractive) {
    $.clock.every(TICK_MS, () => {
      void onTick($).catch(() => {})
    })
  }
  return out
}

async function onCommand($: any, e: any) {
  const arg = String(e.args ?? '').trim()
  const now: number = await $.clock.now()
  if (arg === '') return { text: statusText(await read($, state), config, now, lang) }
  if (arg === 'off') {
    await patch($, () => ({ isPaused: true }))
    return { text: t(lang, 'cmd.off') }
  }
  if (arg === 'on') {
    await patch($, () => ({ isPaused: false, isCapNoticed: false }))
    return { text: t(lang, 'cmd.on') }
  }
  if (arg === 'now') {
    if (!config.enabled) return { text: t(lang, 'cmd.disabled') }
    const s = await read($, state)
    if (s.isTurnRunning) return { text: t(lang, 'cmd.turnRunning') }
    const r = await poke($, 'command')
    return { text: t(lang, 'cmd.result', { text: r.text }) }
  }
  return { text: t(lang, 'cmd.usage') }
}

async function onAbovePrompt($: any, e: any, next: any) {
  if (e.props?.hasSurvey || e.props?.isWorking) return next(e)
  await read($, tickAt) // subscribe: redraw the countdown on every tick
  const l = (await read($, langState)) as Lang
  const text = bandText(await read($, state), config, await $.clock.now(), l)
  if (text === null) return next(e)
  const ui = $.ui.resolve(e)
  const { Text } = ui
  // AbovePrompt is a hook chain: draw our line in its frame, then what the plugins beneath drew
  const below = await next(e)
  const s = await read($, state)
  return frameBand(
    ui,
    config.bandStyle,
    s.backoffMs > 0,
    e.props?.bodyColumns,
    <Text wrap="truncate-end" dimColor>
      {text}
    </Text>,
    below,
  )
}

/**
 * Frames this mod's band content per `band_style` and stacks the plugins beneath under it.
 * `box`: a rounded frame (yellow when `isWarning`, here while backing off after failures);
 * `rule`: a dim line beneath, only when another plugin drew something below; `plain`: the bare text.
 */
function frameBand(ui: { Box: any; Text: any }, style: BandStyle, isWarning: boolean, bodyColumns: number | undefined, content: any, below: any) {
  const { Box, Text } = ui
  const hasBelow = below !== null && below !== undefined && (below as { type?: string }).type !== 'engine'
  const own =
    style === 'box' ? (
      <Box key="frame" flexDirection="column" borderStyle="round" borderDimColor={isWarning ? undefined : true} borderColor={isWarning ? 'yellow' : undefined} paddingX={1}>
        {content}
      </Box>
    ) : style === 'rule' ? (
      <Box key="frame" flexDirection="column">
        {content}
        {hasBelow ? <Text key="rule" dimColor>{'─'.repeat(Math.max(8, Math.min(bodyColumns ?? 60, 200)))}</Text> : null}
      </Box>
    ) : (
      <Box key="frame" flexDirection="column">
        {content}
      </Box>
    )
  return (
    <Box flexDirection="column">
      {own}
      {below}
    </Box>
  )
}

export const register: Register = (on, options) => {
  config = parseConfig(options as Record<string, unknown> | undefined)

  on('session.start', onSessionStart)
  on('command.run', { command: 'cache-keeper' }, onCommand)

  // A main-loop turn starts: note the "real activity" time; the idle cap counts from here
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await patch($, () => ({ isTurnRunning: true, lastRealTurnAt: now, isCapNoticed: false }))
    return next(e)
  })

  // Every real model request refreshes the cache: restart the countdown. The cache lifetime
  // counts from the request's START, so we record when it went out, not when the reply ended
  // (a long reply can take minutes). Subagent requests do not share main's prefix: skipped.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const startedAt = await $.clock.now()
    await patch($, () => ({ lastRequestAt: startedAt }))
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      // Only when turn.step saw no request (interrupted before the first one) fill in the end time
      await patch($, s => ({ isTurnRunning: false, lastRequestAt: s.lastRequestAt ?? now }))
    }
    return next(e)
  })

  // /clear: the conversation is gone, and so is the cached prefix; counters stay, timing resets
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await patch($, () => ({ lastRequestAt: null, lastAttemptAt: null, backoffMs: 0, isTurnRunning: false, isCapNoticed: false }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, onAbovePrompt)
}
