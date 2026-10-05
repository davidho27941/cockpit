// auto-handover pure functions: settings clamping, folder and path rules, the trigger gate,
// note text, band and status text. No `$` here; shared by register.tsx and the tests.
// Every function that produces text takes the language as a parameter.

import type { HandoverRecord, HandoverTrigger } from '../types'
import { t } from './i18n'
import type { Lang } from './i18n'

export type { HandoverRecord, HandoverTrigger }
export { resolveLang, t, LANGS, DEFAULT_LANG } from './i18n'
export type { Lang } from './i18n'

export const PLUGIN = 'auto-handover'
export const DEFAULT_DIR = '~/.claude/handovers'
export const DEFAULT_THRESHOLD = 75
export const MIN_THRESHOLD = 40
export const MAX_THRESHOLD = 95
export const DEFAULT_COOLDOWN_MIN = 10
export const DEFAULT_RESUME_HOURS = 24
/** Wait this long after a turn ends before acting, so the engine can finish wrapping the turn up. */
export const RUN_DELAY_MS = 1500
export const TOAST_MS = 8000
/** The band starts showing this many points below the threshold. */
export const BAND_NEAR_POINTS = 10
export const MAX_NOTE_BYTES = 256 * 1024

// ── Settings ─────────────────────────────────────────────────────────────────

export type Settings = {
  threshold: number
  dir: string
  cooldownMs: number
  resumeMs: number
  injectAfterCompact: boolean
  /** The `language` option as given (`auto` or a Lang); resolved at session.start. */
  language: string
  /** How the band line is framed (`band_style`). */
  bandStyle: BandStyle
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

/** userConfig → settings; the threshold is clamped to 40..95, cooldown and resume window never negative. */
export function readSettings(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const o = options ?? {}
  const threshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.round(num(o.threshold, DEFAULT_THRESHOLD))))
  const dirRaw = typeof o.handover_dir === 'string' && o.handover_dir.trim() ? o.handover_dir : DEFAULT_DIR
  const cooldownMin = Math.max(0, num(o.cooldown_minutes, DEFAULT_COOLDOWN_MIN))
  const resumeHours = Math.max(0, num(o.resume_hours, DEFAULT_RESUME_HOURS))
  const inject = o.inject_after_compact === undefined ? true : o.inject_after_compact === true || o.inject_after_compact === 'true'
  const language = typeof o.language === 'string' && o.language.trim() ? o.language.trim() : 'auto'
  return { threshold, dir: dirRaw, cooldownMs: cooldownMin * 60_000, resumeMs: resumeHours * 3_600_000, injectAfterCompact: inject, language, bandStyle: parseBandStyle(o.band_style) }
}

// ── Folder and paths ─────────────────────────────────────────────────────────
// Notes are written to one folder under the home directory only: `~`, `~/…` or an absolute
// path, which after expansion must lie under the home directory.

export function expandDir(raw: string, home: string, lang: Lang = 'en'): { ok: true; path: string } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text) return { ok: false, error: t(lang, 'dir.empty') }
  if (text.includes('\0')) return { ok: false, error: t(lang, 'dir.badChars') }
  let path: string
  if (text === '~') path = home
  else if (text.startsWith('~/')) path = `${home}/${text.slice(2)}`
  else if (text.startsWith('/')) path = text
  else return { ok: false, error: t(lang, 'dir.notAbsolute', { value: truncate(text, 60) }) }
  path = path.replace(/\/+$/, '')
  if (path.split('/').some(seg => seg === '..')) return { ok: false, error: t(lang, 'dir.dotdot') }
  if (!isUnder(path, home)) return { ok: false, error: t(lang, 'dir.outsideHome', { path }) }
  return { ok: true, path }
}

export function isUnder(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, '')
  return child.startsWith(`${p}/`)
}

/** Abbreviates the home directory to ~, for display. */
export function tildify(path: string, home: string): string {
  if (path === home) return '~'
  return isUnder(path, home) ? `~${path.slice(home.replace(/\/+$/, '').length)}` : path
}

/** Project root → folder name: `/Users/me/code/foo` → `Users-me-code-foo`. */
export function projectSlug(root: string): string {
  const slug = root
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[-.]+/, '')
  return slug || 'root'
}

/** Timestamped file name: ISO without colons or milliseconds, `2026-10-04T13-05-22Z.md`. */
export function stampName(nowMs: number): string {
  return `${new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.md`
}

export function notePaths(dir: string, root: string, nowMs: number): { folder: string; stamped: string; latest: string } {
  const folder = `${dir}/${projectSlug(root)}`
  return { folder, stamped: `${folder}/${stampName(nowMs)}`, latest: `${folder}/latest.md` }
}

// ── Trigger gate ─────────────────────────────────────────────────────────────

export type GateFacts = {
  percent: number | null
  threshold: number
  isTurnRunning: boolean
  isPaused: boolean
  inFlight: boolean
  lastHandoverAt: number | null
  cooldownMs: number
  now: number
}

/** May we hand over automatically now? null = yes, otherwise the reason (shown by /handover and tested). */
export function gateReason(f: GateFacts, lang: Lang = 'en'): string | null {
  if (f.isPaused) return t(lang, 'gate.paused')
  if (f.inFlight) return t(lang, 'gate.inFlight')
  if (f.isTurnRunning) return t(lang, 'gate.turnRunning')
  if (f.percent === null) return t(lang, 'gate.noReading')
  if (f.percent < f.threshold) return t(lang, 'gate.below', { percent: f.percent, threshold: f.threshold })
  if (f.lastHandoverAt !== null && f.now - f.lastHandoverAt < f.cooldownMs) {
    return t(lang, 'gate.cooldown', { ago: duration(f.now - f.lastHandoverAt), minutes: Math.round(f.cooldownMs / 60_000) })
  }
  return null
}

/** Is the threshold reached, whatever else is true? session.measure uses it to arm. */
export function isOverThreshold(percent: number | null | undefined, threshold: number): boolean {
  return typeof percent === 'number' && percent >= threshold
}

// ── Note text ────────────────────────────────────────────────────────────────

const HEADING_KEYS = ['note.title', 'note.h1', 'note.h2', 'note.h3', 'note.h4', 'note.h5', 'note.h6', 'note.h7', 'note.h8', 'note.h9'] as const

/** The note's headings, title first, in the chosen language. */
export function noteHeadings(lang: Lang): string[] {
  return HEADING_KEYS.map(k => t(lang, k))
}

/** The prompt asking the model for a handover note (forked onto the conversation's tail, so it sees everything). */
export function handoverPrompt(lang: Lang): string {
  return t(lang, 'prompt.handover', { headings: noteHeadings(lang).join('\n') })
}

/** The instruction handed to the compaction summarizer: keep the note's facts. */
export function compactInstructions(lang: Lang): string {
  return t(lang, 'prompt.compact')
}

export type NoteMeta = {
  project: string
  sessionId: string
  nowMs: number
  percent: number | null
  model: string
  trigger: HandoverTrigger
}

/** File content: a YAML front block (machine-readable keys) followed by the note. */
export function renderNoteFile(meta: NoteMeta, note: string, lang: Lang = 'en'): string {
  const lines = [
    '---',
    `project: ${meta.project}`,
    `session: ${meta.sessionId}`,
    `time: ${new Date(meta.nowMs).toISOString()}`,
    `context_percent: ${meta.percent === null ? 'unknown' : meta.percent}`,
    `model: ${meta.model}`,
    `trigger: ${meta.trigger}`,
    `language: ${lang}`,
    `written_by: ${PLUGIN}`,
    '---',
    '',
  ]
  return `${lines.join('\n')}${ensureHeading(note, lang).trim()}\n`
}

/** The model sometimes drops the title line; put it back. */
export function ensureHeading(note: string, lang: Lang = 'en'): string {
  const s = note.trim()
  return s.startsWith('# ') ? s : `${t(lang, 'note.title')}\n\n${s}`
}

/** Removes the front block, leaving the note body (for /handover show and injection). */
export function stripFrontMatter(text: string): string {
  const m = /^---\n[\s\S]*?\n---\n\n?/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/** The message appended to the conversation after compaction. */
export function injectedMessage(note: string, file: string, lang: Lang = 'en'): string {
  return [t(lang, 'inject.framing'), '', ensureHeading(note, lang).trim(), '', t(lang, 'inject.file', { file })].join('\n')
}

/** The context block a new session starts with. */
export function resumeBlock(noteText: string, ageMs: number, file: string, lang: Lang = 'en'): string {
  return [t(lang, 'resume.framing', { ago: duration(ageMs), file }), '', stripFrontMatter(noteText).trim()].join('\n')
}

// ── Time and text ────────────────────────────────────────────────────────────

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  const h = Math.floor(s / 3600)
  if (h < 48) return `${h}h${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(h / 24)}d`
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

// ── Band and status text ─────────────────────────────────────────────────────

export type BandFacts = {
  percent: number | null
  threshold: number
  phase: 'idle' | 'writing' | 'compacting'
  last: HandoverRecord | null
  failure: string | null
  isPaused: boolean
  now: number
  home: string | null
}

export type BandLine = { text: string; tone: 'dim' | 'warn' }

/** One band line; null = take no row (far from the threshold, never handed over, no failure). */
export function bandLine(f: BandFacts, lang: Lang = 'en'): BandLine | null {
  if (f.failure !== null) return { text: t(lang, 'band.failure', { reason: f.failure }), tone: 'warn' }
  if (f.phase === 'writing') return { text: t(lang, 'band.writing'), tone: 'warn' }
  if (f.phase === 'compacting') return { text: t(lang, 'band.compacting'), tone: 'warn' }
  const near = f.percent !== null && f.percent >= f.threshold - BAND_NEAR_POINTS
  if (!near && f.last === null) return null
  const parts = [t(lang, 'band.context', { percent: f.percent === null ? '?' : `${f.percent}%`, threshold: f.threshold })]
  if (f.isPaused) parts.push(t(lang, 'band.paused'))
  if (f.last) {
    parts.push(t(lang, 'band.last', { ago: duration(f.now - f.last.at) }))
    parts.push(f.home ? tildify(f.last.file, f.home) : f.last.file)
  }
  return { text: parts.join(' · '), tone: 'dim' }
}

export function statusText(f: BandFacts & { gate: string | null; dirDisplay: string; count: number }, lang: Lang = 'en'): string {
  const lines = [
    t(lang, 'status.head', {
      threshold: f.threshold,
      percent: f.percent === null ? t(lang, 'status.noReading') : `${f.percent}%`,
      paused: f.isPaused ? t(lang, 'status.pausedSuffix') : '',
    }),
    t(lang, 'status.dir', { dir: f.dirDisplay }),
  ]
  if (f.failure) lines.push(t(lang, 'status.failure', { reason: f.failure }))
  lines.push(f.gate === null ? t(lang, 'status.ready') : t(lang, 'status.gate', { reason: f.gate }))
  lines.push(
    f.last
      ? t(lang, 'status.last', {
          ago: duration(f.now - f.last.at),
          trigger: f.last.trigger,
          percent: f.last.percent ?? '?',
          after: f.last.percentAfter !== null ? ` → ${f.last.percentAfter}%` : '',
          file: f.home ? tildify(f.last.file, f.home) : f.last.file,
        })
      : t(lang, 'status.lastNone'),
  )
  lines.push(t(lang, 'status.count', { count: f.count }))
  return lines.join('\n')
}


// ── Band framing ───────────────────────────────────────────────────────────

/** How the mod's line above the prompt is framed: a rounded box, a thin rule beneath, or bare text. */
export type BandStyle = 'box' | 'rule' | 'plain'

/** The `band_style` option; anything but `rule` or `plain` is the default box. */
export function parseBandStyle(v: unknown): BandStyle {
  return v === 'rule' || v === 'plain' ? v : 'box'
}
