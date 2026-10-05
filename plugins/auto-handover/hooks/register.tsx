// auto-handover: when context usage reaches the threshold, write a handover note first, then compact,
// and hand the note to whoever continues.
//
// - Usage comes from session.measure; the mod acts only between turns ($.session.compact refuses mid-turn).
// - The note is written by $.model.fork: the conversation prefix is served from the prompt cache, so it is cheap;
//   it is saved under handover_dir, which must be under the home directory.
// - The note goes to the compaction summarizer as instructions, and after compaction it is appended to the
//   conversation as a meta message (can be turned off).
// - A new session in the same project gets the latest note as opening context (age limit configurable).
// - Manual /compact and the engine's own auto-compact also get a note first (session.compact hook).
// - No network, no shell; files are written only under handover_dir.
// - Language: the `language` option, or the LC_ALL / LC_MESSAGES / LANG environment when `auto`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { HandoverRecord, HandoverTrigger } from '../types'
import {
  MAX_NOTE_BYTES,
  RUN_DELAY_MS,
  TOAST_MS,
  bandLine,
  compactInstructions,
  expandDir,
  gateReason,
  handoverPrompt,
  injectedMessage,
  isOverThreshold,
  notePaths,
  readSettings,
  renderNoteFile,
  resolveLang,
  resumeBlock,
  statusText,
  stripFrontMatter,
  t,
  tildify,
  truncate,
} from './logic'
import type { BandStyle, Lang, Settings } from './logic'

const lastPercent = atom({ plugin: 'auto-handover', key: 'lastPercent' } as const, null)
const phase = atom({ plugin: 'auto-handover', key: 'phase' } as const, 'idle')
const last = atom({ plugin: 'auto-handover', key: 'last' } as const, null)
const count = atom({ plugin: 'auto-handover', key: 'count' } as const, 0)
const isPaused = atom({ plugin: 'auto-handover', key: 'isPaused' } as const, false)
const failure = atom({ plugin: 'auto-handover', key: 'failure' } as const, null)
const langState = atom({ plugin: 'auto-handover', key: 'lang' } as const, 'en')

// Module-level state: reset on hot reload.
let settings: Settings = readSettings(undefined)
let lang: Lang = 'en'
let isInteractive = true
let isTurnRunning = false
let armed = false
let inFlight = false
/** A forced handover queued by /handover now: skips the threshold and cooldown next time. */
let forceNext = false
let pendingTimer: Timer | null = null
/** After the model failed to write a note: no automatic retry before this time. */
let retryAfter: number | null = null
/** prompt.context cache: the same file at the same mtime is read once. */
let resumeCache: { key: string; text: string } | null = null

type $ = EngineInterface

function toast($: $, text: string): void {
  try {
    $.ui.toast(text, { timeoutMs: TOAST_MS })
  } catch {}
}

function debug($: $, text: string): void {
  try {
    $.ui.log(`auto-handover: ${text}`, { to: 'debug' })
  } catch {}
}

async function home($: $): Promise<string | null> {
  const h = await $.env.get('HOME')
  return h && h.startsWith('/') ? h : null
}

type Located = { ok: true; home: string; dir: string } | { ok: false; error: string }

/** Expands handover_dir and checks it lies under the home directory; an invalid value disables the mod with a reason, never a fallback folder. */
async function locate($: $): Promise<Located> {
  const h = await home($)
  if (!h) return { ok: false, error: t(lang, 'home.unset') }
  const expanded = expandDir(settings.dir, h, lang)
  if (!expanded.ok) return { ok: false, error: expanded.error }
  return { ok: true, home: h, dir: expanded.path }
}

async function percentNow($: $): Promise<number | null> {
  try {
    const { context } = await $.session.usage()
    return typeof context.percent === 'number' ? context.percent : null
  } catch {
    return null
  }
}

type Written = { ok: true; note: string; file: string; folder: string } | { ok: false; reason: string }

/** Asks the model for the note and saves it. Failures come back as a reason, never as an exception. */
async function writeNote($: $, trigger: HandoverTrigger, percent: number | null): Promise<Written> {
  const loc = await locate($)
  if (!loc.ok) {
    await update($, failure, () => loc.error)
    return { ok: false, reason: loc.error }
  }
  await update($, failure, () => null)
  const r = await $.model.fork({ prompt: handoverPrompt(lang) })
  if (!r.isAnswered) {
    if (r.reason === 'nothing-to-fork') return { ok: false, reason: t(lang, 'fail.nothingToFork') }
    const why =
      r.reason === 'api-error'
        ? t(lang, 'fail.apiError', { error: r.error, status: r.status !== null ? ` ${r.status}` : '' })
        : r.reason === 'empty-reply'
          ? t(lang, 'fail.emptyReply')
          : t(lang, 'fail.aborted')
    return { ok: false, reason: why }
  }
  debug($, `fork wrote the note: cache_read ${r.usage.cache_read_input_tokens}, output ${r.usage.output_tokens}`)
  const now = await $.clock.now()
  const root = await $.session.root()
  const paths = notePaths(loc.dir, root, now)
  const text = renderNoteFile(
    { project: root, sessionId: await $.session.id(), nowMs: now, percent, model: await $.session.model(), trigger },
    r.text,
    lang,
  )
  try {
    await $.fs.write(paths.stamped, text)
    await $.fs.write(paths.latest, text)
  } catch (err) {
    return { ok: false, reason: t(lang, 'fail.write', { reason: truncate(String(err), 80) }) }
  }
  return { ok: true, note: r.text, file: paths.latest, folder: paths.folder }
}

async function inject($: $, note: string, file: string): Promise<void> {
  if (!settings.injectAfterCompact) return
  debug($, `appending the note to the conversation (${note.length} chars)`)
  try {
    const out = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: injectedMessage(note, file, lang) }] } })
    if (out.deny !== undefined) debug($, `could not append the note: ${out.deny}`)
  } catch (err) {
    debug($, `could not append the note: ${truncate(String(err), 80)}`)
  }
}

async function record($: $, rec: HandoverRecord): Promise<void> {
  await update($, last, () => rec)
  await update($, count, n => n + 1)
  resumeCache = null
  try {
    $.ui.invalidate('prompt.context')
  } catch {}
}

/**
 * The handover itself: write the note → compact → append the note to the conversation.
 * `force` is /handover now: it skips the threshold and cooldown, but still never acts mid-turn.
 */
async function runHandover($: $, trigger: HandoverTrigger, force = false): Promise<string> {
  if (inFlight) return t(lang, 'gate.inFlight')
  if (isTurnRunning) {
    armed = true
    if (force) forceNext = true
    return t(lang, 'gate.turnRunning')
  }
  const now = await $.clock.now()
  const percent = await percentNow($)
  if (percent !== null) await update($, lastPercent, () => percent)
  if (!force) {
    if (retryAfter !== null && now < retryAfter) return 'backing off after a failed note'
    const prev = await read($, last)
    const why = gateReason(
      {
        percent,
        threshold: settings.threshold,
        isTurnRunning,
        isPaused: await read($, isPaused),
        inFlight,
        lastHandoverAt: prev?.at ?? null,
        cooldownMs: settings.cooldownMs,
        now,
      },
      lang,
    )
    if (why !== null) {
      armed = false
      return why
    }
  }
  inFlight = true
  armed = false
  await update($, phase, () => 'writing')
  try {
    const written = await writeNote($, trigger, percent)
    if (!written.ok) {
      retryAfter = now + settings.cooldownMs
      toast($, t(lang, 'toast.failed', { reason: written.reason }))
      return written.reason
    }
    await update($, phase, () => 'compacting')
    let c
    try {
      c = await $.session.compact({ instructions: `${compactInstructions(lang)}\n\n${written.note}` })
    } catch (err) {
      // Most likely a turn started in between: the note is saved, so compact after the next turn ends.
      armed = true
      debug($, `compaction refused: ${truncate(String(err), 80)}`)
      return t(lang, 'compactRejected', { file: written.file, reason: truncate(String(err), 60) })
    }
    if (c.skip !== undefined) {
      toast($, t(lang, 'toast.compactSkipped', { reason: c.skip }))
      await record($, { at: now, file: written.file, trigger, percent, percentAfter: null })
      return `compaction skipped: ${c.skip}`
    }
    await inject($, written.note, written.file)
    let percentAfter: number | null = null
    if (typeof c.tokensAfter === 'number') {
      try {
        const { context } = await $.session.usage()
        if (context.window > 0) percentAfter = Math.round((c.tokensAfter / context.window) * 100)
      } catch {}
    }
    await record($, { at: now, file: written.file, trigger, percent, percentAfter })
    const h = await home($)
    toast(
      $,
      t(lang, 'toast.done', {
        percent: percent ?? '?',
        after: percentAfter !== null ? ` → ${percentAfter}%` : '',
        file: h ? tildify(written.file, h) : written.file,
      }),
    )
    return 'handed over and compacted'
  } finally {
    inFlight = false
    await update($, phase, () => 'idle')
  }
}

function schedule($: $): void {
  if (!isInteractive && !forceNext) return
  if (pendingTimer) pendingTimer.cancel()
  pendingTimer = $.clock.after(RUN_DELAY_MS, () => {
    pendingTimer = null
    const force = forceNext
    forceNext = false
    void runHandover($, force ? 'command' : 'threshold', force).catch(err => debug($, `handover failed: ${truncate(String(err), 80)}`))
  })
}

/** Over the threshold, not cooling down, not paused → arm; schedule right away while idle. */
async function consider($: $, percent: number | null): Promise<void> {
  if (!isOverThreshold(percent, settings.threshold)) {
    armed = false
    return
  }
  if (await read($, isPaused)) return
  const now = await $.clock.now()
  if (retryAfter !== null && now < retryAfter) return
  const prev = await read($, last)
  if (prev && now - prev.at < settings.cooldownMs) return
  armed = true
  if (!isTurnRunning && !inFlight) schedule($)
}

/** The latest note, when fresh enough, as a context block for a new session. */
async function resumeText($: $): Promise<{ text: string; ageMs: number; file: string } | null> {
  if (settings.resumeMs <= 0) return null
  if ((await read($, count)) > 0) return null // this session handed over itself: the note is already in the conversation
  const loc = await locate($)
  if (!loc.ok) return null
  const root = await $.session.root()
  const now = await $.clock.now()
  const { latest } = notePaths(loc.dir, root, now)
  const st = await $.fs.stat(latest).catch(() => undefined)
  if (!st || st.kind !== 'file' || st.size > MAX_NOTE_BYTES) return null
  const ageMs = now - st.mtimeMs
  if (ageMs > settings.resumeMs) return null
  const key = `${latest}@${st.mtimeMs}`
  if (!resumeCache || resumeCache.key !== key) {
    const text = await $.fs.read(latest)
    resumeCache = { key, text: typeof text === 'string' ? text : '' }
  }
  return { text: resumeCache.text, ageMs, file: latest }
}

async function onCommand($: $, args: string): Promise<{ text: string }> {
  const arg = args.trim()
  const now = await $.clock.now()
  const h = await home($)
  if (arg === 'now') {
    // $.session.compact cannot run inside a command.run hook (it would compact under the turn this hook holds): schedule it.
    await update($, isPaused, () => false)
    if (inFlight) return { text: t(lang, 'cmd.inFlight') }
    forceNext = true
    armed = true
    if (isTurnRunning) return { text: t(lang, 'cmd.nowTurnRunning') }
    schedule($)
    return { text: t(lang, 'cmd.nowScheduled', { seconds: RUN_DELAY_MS / 1000 }) }
  }
  if (arg === 'off') {
    await update($, isPaused, () => true)
    armed = false
    forceNext = false
    if (pendingTimer) {
      pendingTimer.cancel()
      pendingTimer = null
    }
    return { text: t(lang, 'cmd.off') }
  }
  if (arg === 'on') {
    await update($, isPaused, () => false)
    await consider($, await read($, lastPercent))
    return { text: t(lang, 'cmd.on') }
  }
  if (arg === 'show') {
    const prev = await read($, last)
    const loc = await locate($)
    let file = prev?.file ?? null
    if (!file && loc.ok) file = notePaths(loc.dir, await $.session.root(), now).latest
    if (!file) return { text: t(lang, 'cmd.noNote') }
    try {
      const text = await $.fs.read(file)
      return { text: `${h ? tildify(file, h) : file}\n\n${stripFrontMatter(typeof text === 'string' ? text : '')}` }
    } catch {
      return { text: t(lang, 'cmd.unreadable', { file }) }
    }
  }
  if (arg !== '') return { text: t(lang, 'cmd.usage') }
  const loc = await locate($)
  const prev = await read($, last)
  const percent = await read($, lastPercent)
  return {
    text: statusText(
      {
        percent,
        threshold: settings.threshold,
        phase: await read($, phase),
        last: prev,
        failure: await read($, failure),
        isPaused: await read($, isPaused),
        now,
        home: h,
        count: await read($, count),
        dirDisplay: loc.ok ? (h ? tildify(loc.dir, h) : loc.dir) : settings.dir,
        gate: gateReason(
          {
            percent,
            threshold: settings.threshold,
            isTurnRunning,
            isPaused: await read($, isPaused),
            inFlight,
            lastHandoverAt: prev?.at ?? null,
            cooldownMs: settings.cooldownMs,
            now,
          },
          lang,
        ),
      },
      lang,
    ),
  }
}

export const register: Register = (on, options) => {
  settings = readSettings(options)
  lang = resolveLang(settings.language, {})

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    isInteractive = e.isInteractive
    lang = resolveLang(settings.language, {
      LC_ALL: await $.env.get('LC_ALL'),
      LC_MESSAGES: await $.env.get('LC_MESSAGES'),
      LANG: await $.env.get('LANG'),
    })
    await update($, langState, () => lang)
    await $.command.register({
      name: 'handover',
      description: 'Handover status; now hands over and compacts, show prints the latest note, off/on pauses or resumes automatic handovers',
      argumentHint: '[now|show|off|on]',
    })
    const loc = await locate($)
    await update($, failure, () => (loc.ok ? null : loc.error))
    return out
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && typeof e.context.percent === 'number') {
      const p = e.context.percent
      await update($, lastPercent, () => p)
      await consider($, p)
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    if (pendingTimer) {
      pendingTimer.cancel()
      pendingTimer = null
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) return out
    isTurnRunning = false
    if (armed) schedule($)
    else await consider($, await read($, lastPercent))
    return out
  })

  // Manual /compact and the engine's own auto-compact: write a note first, hand it to the summarizer, append it afterwards.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'plugin' || e.trigger === 'precompute' || inFlight) return next(e)
    if (await read($, isPaused)) return next(e)
    inFlight = true
    await update($, phase, () => 'writing')
    let written: Written
    try {
      written = await writeNote($, e.trigger === 'manual' ? 'manual' : 'auto', await read($, lastPercent))
    } catch (err) {
      inFlight = false
      await update($, phase, () => 'idle')
      debug($, `could not write the note: ${truncate(String(err), 80)}`)
      return next(e)
    }
    if (!written.ok) {
      inFlight = false
      await update($, phase, () => 'idle')
      debug($, written.reason)
      return next(e)
    }
    await update($, phase, () => 'compacting')
    try {
      const instructions = `${e.instructions ? `${e.instructions}\n\n` : ''}${compactInstructions(lang)}\n\n${written.note}`
      const out = await next({ ...e, instructions })
      if (out.skip === undefined) {
        await inject($, written.note, written.file)
        const now = await $.clock.now()
        await record($, { at: now, file: written.file, trigger: e.trigger === 'manual' ? 'manual' : 'auto', percent: await read($, lastPercent), percentAfter: null })
        const h = await home($)
        toast($, t(lang, 'toast.noteWritten', { file: h ? tildify(written.file, h) : written.file }))
      }
      return out
    } finally {
      inFlight = false
      await update($, phase, () => 'idle')
    }
  })

  on('prompt.context', async ($, e, next) => {
    const out = await next(e)
    try {
      const found = await resumeText($)
      if (!found) return out
      const h = await home($)
      const text = resumeBlock(found.text, found.ageMs, h ? tildify(found.file, h) : found.file, lang)
      return { ...out, blocks: [...out.blocks.filter(b => b.name !== 'handover'), { name: 'handover', text }] }
    } catch (err) {
      debug($, `could not read the handover note: ${truncate(String(err), 80)}`)
      return out
    }
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') {
      isTurnRunning = false
      armed = false
      forceNext = false
      retryAfter = null
      resumeCache = null
      if (pendingTimer) {
        pendingTimer.cancel()
        pendingTimer = null
      }
    }
    return next(e)
  })

  on('command.run', { command: 'handover' }, ($, e) => onCommand($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const line = bandLine(
      {
        percent: await read($, lastPercent),
        threshold: settings.threshold,
        phase: await read($, phase),
        last: await read($, last),
        failure: await read($, failure),
        isPaused: await read($, isPaused),
        now: await $.clock.now(),
        home: await home($),
      },
      await read($, langState),
    )
    if (line === null) return next(e)
    const ui = $.ui.resolve(e)
    const { Text } = ui
    // AbovePrompt is a hook chain: draw our own line in its frame, then stack what the plugins below drew.
    const below = await next(e)
    return frameBand(
      ui,
      settings.bandStyle,
      line.tone === 'warn',
      e.props.bodyColumns,
      <Text wrap="truncate-end" dimColor={line.tone === 'dim'} color={line.tone === 'warn' ? 'yellow' : undefined}>
        {line.text}
      </Text>,
      below,
    )
  })
}

/**
 * Frames this mod's band content per `band_style` and stacks the plugins beneath under it.
 * `box`: a rounded frame (yellow when `isWarning`); `rule`: a dim line beneath, only when another
 * plugin drew something below; `plain`: the bare text.
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
