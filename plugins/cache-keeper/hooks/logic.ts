// cache-keeper pure functions: settings parsing, when to poke, backoff, the
// idle cap, and the band / status texts. No `$` here; shared with the tests.

import type { KeeperState } from '../types'
import { t } from './i18n'
import type { Lang } from './i18n'

export type { KeeperState }
export type { Lang }

export const PLUGIN = 'cache-keeper'
/** The timer looks every 30 seconds */
export const TICK_MS = 30_000
/** The prompt cache lives one hour past its last use */
export const CACHE_TTL_MIN = 60
export const DEFAULT_INTERVAL_MIN = 50
export const MIN_INTERVAL_MIN = 5
export const MAX_INTERVAL_MIN = 59
export const DEFAULT_IDLE_CAP_HOURS = 4
/** First failure waits a minute, then doubles, up to one interval */
export const FIRST_BACKOFF_MS = 60_000
export const TOAST_MS = 8000
/** The one line sent to the model: short, and it does not invite a long reply */
export const POKE_PROMPT = 'Reply with exactly the single word: ok'

export const EMPTY_STATE: KeeperState = {
  lastRequestAt: null,
  lastRealTurnAt: null,
  lastAttemptAt: null,
  pokes: 0,
  failures: 0,
  lastCacheRead: null,
  lastInput: null,
  isPaused: false,
  backoffMs: 0,
  isPoking: false,
  isTurnRunning: false,
  isCapNoticed: false,
}

// ── Settings ────────────────────────────────────────────────────────────────

export type KeeperConfig = {
  enabled: boolean
  intervalMs: number
  /** 0 = no cap */
  idleCapMs: number
  showBand: boolean
  /** The raw `language` option; resolved against the environment at session.start */
  language: unknown
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/** The interval is held to 5–59 minutes: past 60 the cache is already gone, under 5 is just spending */
export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_INTERVAL_MIN
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(minutes)))
}

export function parseConfig(options: Readonly<Record<string, unknown>> | undefined): KeeperConfig {
  const o = options ?? {}
  const capHours = Math.max(0, num(o.max_idle_hours, DEFAULT_IDLE_CAP_HOURS))
  return {
    enabled: bool(o.enabled, true),
    intervalMs: clampInterval(num(o.interval_minutes, DEFAULT_INTERVAL_MIN)) * 60_000,
    idleCapMs: Math.round(capHours * 3_600_000),
    showBand: bool(o.show_band, true),
    language: o.language,
  }
}

// ── Timing ──────────────────────────────────────────────────────────────────

/**
 * When the next poke is due: normally one interval after the last request;
 * while backing off, the backoff after the last attempt (whichever is later).
 */
export function nextPokeAt(lastRequestAt: number, lastAttemptAt: number | null, intervalMs: number, backoffMs: number): number {
  const regular = lastRequestAt + intervalMs
  if (backoffMs <= 0 || lastAttemptAt === null) return regular
  return Math.max(regular, lastAttemptAt + backoffMs)
}

export function isDue(now: number, s: Pick<KeeperState, 'lastRequestAt' | 'lastAttemptAt' | 'backoffMs'>, intervalMs: number): boolean {
  if (s.lastRequestAt === null) return false
  return now >= nextPokeAt(s.lastRequestAt, s.lastAttemptAt, intervalMs, s.backoffMs)
}

/** Past the idle cap since the last real turn; a cap of 0 means no cap */
export function isPastIdleCap(lastRealTurnAt: number | null, now: number, capMs: number): boolean {
  if (capMs <= 0 || lastRealTurnAt === null) return false
  return now - lastRealTurnAt >= capMs
}

/** Backoff after a failure: 1m, 2m, 4m… up to one interval */
export function nextBackoff(prev: number, intervalMs: number): number {
  const next = prev <= 0 ? FIRST_BACKOFF_MS : prev * 2
  return Math.min(next, intervalMs)
}

export type UsageLike = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** The poke missed the cache: under a quarter of the input was served from it (usually the entry had lapsed) */
export function isCacheMiss(u: UsageLike): boolean {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (total <= 0) return false
  return u.cache_read_input_tokens * 4 < total
}

// ── Text ────────────────────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** For countdowns: under a minute reads "under 1m" */
export function countdown(ms: number, lang: Lang): string {
  if (ms < 60_000) return t(lang, 'countdown.under1m')
  return duration(ms)
}

/** The band line; null means no line */
export function bandText(s: KeeperState, cfg: KeeperConfig, now: number, lang: Lang): string | null {
  if (!cfg.enabled || !cfg.showBand || s.isPaused) return null
  if (s.lastRequestAt === null) return null
  if (s.isPoking) return t(lang, 'band.poking')
  if (isPastIdleCap(s.lastRealTurnAt, now, cfg.idleCapMs)) return t(lang, 'band.capped', { d: duration(cfg.idleCapMs) })
  const at = nextPokeAt(s.lastRequestAt, s.lastAttemptAt, cfg.intervalMs, s.backoffMs)
  const parts = [t(lang, 'band.warm'), t(lang, 'band.next', { t: countdown(at - now, lang) })]
  if (s.pokes > 0) parts.push(t(lang, 'band.pokes', { n: s.pokes }))
  if (s.lastCacheRead !== null) parts.push(t(lang, 'band.lastHit', { tok: fmtTokens(s.lastCacheRead) }))
  if (s.backoffMs > 0) parts.push(t(lang, 'band.backoff', { n: s.failures }))
  return parts.join(' · ')
}

/** The /cache-keeper status text */
export function statusText(s: KeeperState, cfg: KeeperConfig, now: number, lang: Lang): string {
  const lines: string[] = []
  lines.push(!cfg.enabled ? t(lang, 'status.disabled') : s.isPaused ? t(lang, 'status.paused') : t(lang, 'status.enabled'))
  lines.push(t(lang, 'status.interval', { interval: duration(cfg.intervalMs), cap: cfg.idleCapMs > 0 ? duration(cfg.idleCapMs) : t(lang, 'status.noCap') }))
  if (s.lastRequestAt === null) lines.push(t(lang, 'status.noRequest'))
  else if (isPastIdleCap(s.lastRealTurnAt, now, cfg.idleCapMs)) lines.push(t(lang, 'status.capped'))
  else {
    const at = nextPokeAt(s.lastRequestAt, s.lastAttemptAt, cfg.intervalMs, s.backoffMs)
    lines.push(t(lang, 'status.next', { ago: duration(now - s.lastRequestAt), next: countdown(at - now, lang) }))
  }
  const hit = s.lastCacheRead !== null ? t(lang, 'status.lastHit', { hit: fmtTokens(s.lastCacheRead), miss: fmtTokens(s.lastInput ?? 0) }) : ''
  lines.push(`${t(lang, 'status.counts', { pokes: s.pokes, failures: s.failures })}${hit}`)
  return lines.join('\n')
}

/** One poke's outcome (for /cache-keeper now and the log) */
export function pokeText(u: UsageLike, lang: Lang): string {
  return isCacheMiss(u)
    ? t(lang, 'poke.miss', { tok: fmtTokens(u.cache_creation_input_tokens + u.input_tokens) })
    : t(lang, 'poke.hit', { hit: fmtTokens(u.cache_read_input_tokens), miss: fmtTokens(u.input_tokens + u.cache_creation_input_tokens) })
}
