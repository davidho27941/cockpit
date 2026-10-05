// secret-guard: keeps API keys, cloud credentials and other secrets out of what the
// model reads.
//
// - `session.append` is the choke point: every row a conversation keeps (the person's
//   prompt, a command's output, a tool result, a delivered message, an injected note,
//   a compaction summary; in the main conversation and in every subagent's) passes
//   it once before it is stored, and the bottom stores what the chain answered. The
//   model's own response blocks and notices it never reads are left alone.
// - `prompt.submit` redacts the person's message before it is shown and stored;
//   `prompt.context` the context blocks (CLAUDE.md and friends); `prompt.attachment`
//   the texts the engine injects on its own (a mentioned file, a reminder).
// - A toast names what was redacted (the label, never the value); the band keeps a
//   count; `/secret-guard` shows the status, pauses, resumes, or runs a self-test.
// - No files, no processes, no network, no model calls. Any failure passes the row
//   through unchanged: the mod never blocks a conversation.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RecentHit } from '../types'
import type { Lang } from './i18n'
import { DEFAULT_LANG, resolveLang, t } from './i18n'
import { addByLabel, bandText, planAppend, pushRecent, readSettings, redact, selfTestText, statusText, toastText } from './logic'
import type { AppendRow, BandStyle, Hit, Settings } from './logic'

const langState = atom({ plugin: 'secret-guard', key: 'lang' } as const, DEFAULT_LANG)
const isPaused = atom({ plugin: 'secret-guard', key: 'isPaused' } as const, false)
const total = atom({ plugin: 'secret-guard', key: 'total' } as const, 0)
const byLabel = atom({ plugin: 'secret-guard', key: 'byLabel' } as const, {})
const recent = atom({ plugin: 'secret-guard', key: 'recent' } as const, [] as RecentHit[])
const badPatterns = atom({ plugin: 'secret-guard', key: 'badPatterns' } as const, [] as string[])

// Module state: re-read from the options on every (re)load.
let settings: Settings = readSettings(undefined)
let lang: Lang = DEFAULT_LANG

function toast($: any, text: string): void {
  try {
    $.ui.toast(text)
  } catch {}
}

async function resolveLanguage($: any): Promise<Lang> {
  const env: { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string } = {}
  try {
    env.LC_ALL = await $.env.get('LC_ALL')
    env.LC_MESSAGES = await $.env.get('LC_MESSAGES')
    env.LANG = await $.env.get('LANG')
  } catch {}
  return resolveLang(settings.language, env)
}

/** Whether anything is scanned right now: enabled in settings and not paused for the session. */
async function isActive($: any): Promise<boolean> {
  if (!settings.enabled) return false
  return !(await read($, isPaused))
}

/** Counts a redaction, remembers where it happened (never the value) and tells the person. */
async function record($: any, hits: Hit[], where: string, agent: string | null): Promise<void> {
  if (!hits.length) return
  const now: number = await $.clock.now()
  const n = hits.reduce((s, h) => s + h.count, 0)
  await update($, total, v => v + n)
  await update($, byLabel, m => addByLabel(m, hits))
  await update($, recent, list => pushRecent(list, hits, where, agent, now))
  toast($, toastText(lang, hits, where, agent))
}

export const register: Register = (on, options) => {
  settings = readSettings(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    lang = await resolveLanguage($)
    await update($, langState, () => lang)
    await update($, badPatterns, () => settings.badPatterns)
    await $.command.register({
      name: 'secret-guard',
      description: t(lang, 'cmd.description'),
      argumentHint: '[off|on|test]',
    })
    return out
  })

  // The person's own message, before it is shown and stored
  on('prompt.submit', async ($, e, next) => {
    try {
      if (!(await isActive($))) return next(e)
      const r = redact(e.text, settings)
      if (!r.hits.length) return next(e)
      const out = await next({ ...e, text: r.text })
      await record($, r.hits, 'prompt', null)
      return out
    } catch {
      return next(e)
    }
  })

  // Every row a conversation keeps, main or subagent, before it is stored
  on('session.append', async ($, e, next) => {
    try {
      if (!(await isActive($))) return next(e)
      const plan = planAppend(e as AppendRow, settings)
      if (plan.kind === 'pass') return next(e)
      const out = await next(plan.input as typeof e)
      await record($, plan.hits, plan.where, plan.agent)
      return out
    } catch {
      return next(e)
    }
  })

  // The context blocks the first message carries (CLAUDE.md, the attached project, ...)
  on('prompt.context', async ($, e, next) => {
    const out = await next(e)
    try {
      if (!(await isActive($))) return out
      const all: Hit[][] = []
      let changed = false
      const blocks = out.blocks.map(b => {
        const r = redact(b.text, settings)
        if (!r.hits.length) return b
        changed = true
        all.push(r.hits)
        return { ...b, text: r.text }
      })
      if (!changed) return out
      await record($, all.flat(), 'context', null)
      return { ...out, blocks }
    } catch {
      return out
    }
  })

  // The texts the engine injects on its own (a mentioned file, a reminder, a hook's output)
  on('prompt.attachment', async ($, e, next) => {
    const out = await next(e)
    try {
      if (!(await isActive($)) || typeof out.text !== 'string') return out
      const r = redact(out.text, settings)
      if (!r.hits.length) return out
      await record($, r.hits, 'attachment', (e as { agentId?: string }).agentId ?? null)
      return { ...out, text: r.text }
    } catch {
      return out
    }
  })

  on('command.run', { command: 'secret-guard' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (arg === 'off') {
      await update($, isPaused, () => true)
      return { text: t(lang, 'cmd.off') }
    }
    if (arg === 'on') {
      await update($, isPaused, () => false)
      return { text: t(lang, 'cmd.on') }
    }
    if (arg === 'test') return { text: selfTestText(lang, settings) }
    if (arg !== '') return { text: t(lang, 'cmd.usage') }
    return {
      text: statusText(lang, {
        enabled: settings.enabled,
        isPaused: await read($, isPaused),
        total: await read($, total),
        byLabel: await read($, byLabel),
        recent: await read($, recent),
        badPatterns: await read($, badPatterns),
        scanToolResults: settings.scanToolResults,
        now: await $.clock.now(),
      }),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const l = (await read($, langState)) as Lang
    const text = bandText(l, {
      enabled: settings.enabled,
      isPaused: await read($, isPaused),
      total: await read($, total),
      recent: await read($, recent),
      badPatterns: await read($, badPatterns),
    })
    if (text === null) return next(e)
    const ui = $.ui.resolve(e)
    const { Text } = ui
    // AbovePrompt is a hook chain: draw our line in its frame, then what the plugins beneath drew
    const below = await next(e)
    const paused = await read($, isPaused)
    const isWarning = paused || (await read($, badPatterns)).length > 0
    return frameBand(
      ui,
      settings.bandStyle,
      isWarning,
      e.props.bodyColumns,
      <Text wrap="truncate-end" dimColor={!paused} color={paused ? 'yellow' : undefined}>
        {text}
      </Text>,
      below,
    )
  })
}

/**
 * Frames this mod's band content per `band_style` and stacks the plugins beneath under it.
 * `box`: a rounded frame (yellow when `isWarning`, here while paused or when a custom pattern did not compile);
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
