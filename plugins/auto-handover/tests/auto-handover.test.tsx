// auto-handover behaviour tests: `claude plugin test plugins/auto-handover`
//
// The test's `on` sits beneath every plugin and plays the engine: the model, compaction,
// the file system and the usage readings are all faked here.

import { describe, expect, mock, test } from 'claude-code/testing'

import { LANGS, MESSAGES, resolveLang, t } from '../hooks/i18n'
import {
  bandLine,
  compactInstructions,
  ensureHeading,
  expandDir,
  gateReason,
  handoverPrompt,
  injectedMessage,
  noteHeadings,
  notePaths,
  projectSlug,
  readSettings,
  renderNoteFile,
  resumeBlock,
  stampName,
  stripFrontMatter,
} from '../hooks/logic'

const HOME = '/home/u'
const PROJECT = `${HOME}/code/proj`
const DIR = `${HOME}/.claude/handovers`
const SLUG = 'home-u-code-proj'
const NOTE = '# Handover note\n\n## Goal\nSwitch the login flow to OAuth.\n\n## Next step (first thing)\nRun `npm test`.'

type World = {
  clock: ReturnType<typeof mock.clock>
  percent: number
  window: number
  forkPrompts: string[]
  forkReply: { isAnswered: true; text: string } | { isAnswered: false; reason: string; status?: number | null; error?: string }
  compactCalls: { trigger: string; instructions: string | undefined }[]
  compactReply: 'ok' | 'skip' | 'reject'
  appended: string[]
  files: Map<string, string>
  mtimes: Map<string, number>
  writes: string[]
  toasts: string[]
  logs: string[]
}

const usage = () => ({ input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 })

function world(on: any, w0: Partial<World> = {}, env: Record<string, string> = { HOME }): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    percent: 10,
    window: 200_000,
    forkPrompts: [],
    forkReply: { isAnswered: true, text: NOTE },
    compactCalls: [],
    compactReply: 'ok',
    appended: [],
    files: new Map(),
    mtimes: new Map(),
    writes: [],
    toasts: [],
    logs: [],
    ...w0,
  }
  mock.env(on, env)
  const value = (v: unknown) => ({ value: v })
  on('session.root', () => value(PROJECT))
  on('session.cwd', () => value(PROJECT))
  on('session.id', () => value('sess-1'))
  on('session.model', () => value('claude-test'))
  on('session.usage', () =>
    value({ startedAt: 0, context: { tokens: Math.round((w.percent / 100) * w.window), window: w.window, percent: w.percent }, rateLimits: [] }),
  )
  on('model.fork', (_$: any, e: any) => {
    w.forkPrompts.push(String(e.prompt))
    return value({ ...w.forkReply, usage: usage() })
  })
  on('session.compact', (_$: any, e: any) => {
    w.compactCalls.push({ trigger: e.trigger, instructions: e.instructions })
    if (w.compactReply === 'reject') throw new Error('a turn is running')
    if (w.compactReply === 'skip') return { skip: 'skipped by the test' }
    w.percent = 20
    return { messages: [{ role: 'user', text: '(summary)', toolUses: [] }], tokensBefore: 150_000, tokensAfter: 40_000 }
  })
  on('session.append', (_$: any, e: any) => {
    w.appended.push(String(e.message?.content?.[0]?.text ?? ''))
    return { message: e.message, uuid: 'row-1' }
  })
  on('fs.write', (_$: any, e: any) => {
    w.files.set(e.path, e.text)
    w.mtimes.set(e.path, w.clock.now())
    w.writes.push(e.path)
    return value(undefined)
  })
  on('fs.read', (_$: any, e: any) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : value(text)
  })
  on('fs.stat', (_$: any, e: any) => {
    const text = w.files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    return value({ kind: 'file', size: text.length, mtimeMs: w.mtimes.get(e.path) ?? 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) })
  })
  on('fs.exists', (_$: any, e: any) => value(w.files.has(e.path)))
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e))
    return value(undefined)
  })
  on('ui.log', (_$: any, e: any) => {
    w.logs.push(String(e.text))
    return value(undefined)
  })
  on('ui.invalidate', () => value(undefined))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('prompt.context', (_$: any, e: any) => ({ blocks: e.blocks }))
  on('session.end', () => ({}))
  // The engine's own drawing: catches the plugin's next(e).
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  return w
}

async function start($: any, w: World, isInteractive = true): Promise<void> {
  await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive })
  await w.clock.settle()
}

async function measure($: any, w: World, percent: number): Promise<void> {
  w.percent = percent
  await $.session.measure({ context: { tokens: Math.round((percent / 100) * w.window), window: w.window, percent }, rateLimits: [], changed: ['context'] })
  await w.clock.settle()
}

async function turn($: any, w: World, id: string): Promise<void> {
  await $.turn.start({ text: 'hi', turnId: id })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: id, reason: 'answer' })
  await w.clock.settle()
}

async function command($: any, w: World, args = ''): Promise<string> {
  const r: any = await $.command.run({ command: 'handover', args, origin: { kind: 'composer' } } as any)
  await w.clock.settle()
  return String(r?.text ?? '')
}

const BAND = { plugin: 'auto-handover', component: 'AbovePrompt', props: {} } as const

async function bandTexts($: any, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, surface } as any)
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return found.map((x: any) => String(x.text ?? ''))
}

const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l))

// The test kit has no implementation of session.append (the plugin's $.session.append gets "no implementation"),
// so injection attempts are counted from the debug log; appended messages are checked when they do arrive.
const injectAttempts = (w: World) => w.logs.filter(l => /appending the note to the conversation/.test(l)).length

// ── Pure functions ───────────────────────────────────────────────────────────

describe('logic', () => {
  test('readSettings: defaults, clamping, strings accepted', async () => {
    const d = readSettings(undefined)
    expect(d.threshold).toBe(75)
    expect(d.dir).toBe('~/.claude/handovers')
    expect(d.cooldownMs).toBe(10 * 60_000)
    expect(d.resumeMs).toBe(24 * 3_600_000)
    expect(d.injectAfterCompact).toBe(true)
    expect(d.language).toBe('auto')
    expect(readSettings({ threshold: 200 }).threshold).toBe(95)
    expect(readSettings({ threshold: 5 }).threshold).toBe(40)
    expect(d.bandStyle).toBe('box')
    expect(readSettings({ threshold: '60', cooldown_minutes: '0', resume_hours: 0, inject_after_compact: false, language: 'ja', band_style: 'plain' })).toEqual({
      threshold: 60,
      dir: '~/.claude/handovers',
      cooldownMs: 0,
      resumeMs: 0,
      injectAfterCompact: false,
      language: 'ja',
      bandStyle: 'plain',
    })
    expect(readSettings({ threshold: 'abc' }).threshold).toBe(75)
  })

  test('resolveLang: option wins, then LC_ALL > LC_MESSAGES > LANG, C/POSIX/empty → en', async () => {
    expect(resolveLang('ja', { LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('zh-TW', {})).toBe('zh-TW')
    expect(resolveLang('en', { LC_ALL: 'ja_JP.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: 'ja_JP.UTF-8', LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'ja_JP' })).toBe('zh-TW')
    expect(resolveLang('auto', { LANG: 'zh_CN.UTF-8' })).toBe('zh-TW')
    expect(resolveLang('auto', { LANG: 'ja' })).toBe('ja')
    expect(resolveLang('auto', { LANG: 'de_DE.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LANG: 'C' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: 'POSIX', LANG: 'ja_JP' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: '', LANG: 'ja_JP' })).toBe('ja')
    expect(resolveLang(undefined, {})).toBe('en')
    expect(resolveLang('nope', { LANG: 'ja_JP' })).toBe('ja')
  })

  test('i18n: every language has every key, and t() falls back to English', async () => {
    const keys = Object.keys(MESSAGES.en).sort()
    for (const lang of LANGS) expect(Object.keys(MESSAGES[lang]).sort()).toEqual(keys)
    expect(t('ja', 'band.paused')).toBe('一時停止中')
    expect(t('zh-TW', 'band.paused')).toBe('已暫停')
    expect(t('en', 'band.paused')).toBe('paused')
    expect(t('ja', 'nope' as any)).toBe('nope')
    expect(noteHeadings('en')[0]).toBe('# Handover note')
    expect(noteHeadings('zh-TW')[0]).toBe('# 交接筆記')
    expect(noteHeadings('ja')[0]).toBe('# 引き継ぎメモ')
    expect(handoverPrompt('en')).toContain('## Next step (first thing)')
    expect(handoverPrompt('ja')).toContain('## 次の一手')
    expect(compactInstructions('zh-TW')).toMatch(/交接筆記/)
  })

  test('expandDir: only ~/… or absolute paths under the home directory', async () => {
    expect(expandDir('~/.claude/handovers', HOME)).toEqual({ ok: true, path: DIR })
    expect(expandDir(`${HOME}/notes/`, HOME)).toEqual({ ok: true, path: `${HOME}/notes` })
    expect(expandDir('notes', HOME).ok).toBe(false)
    expect(expandDir('/etc/handovers', HOME).ok).toBe(false)
    expect(expandDir('~', HOME).ok).toBe(false)
    expect(expandDir('~/../x', HOME).ok).toBe(false)
    const ja = expandDir('/etc/x', HOME, 'ja')
    expect(ja.ok === false && /ホームディレクトリの外/.test(ja.error)).toBe(true)
  })

  test('projectSlug and notePaths', async () => {
    expect(projectSlug('/Users/me/code/foo')).toBe('Users-me-code-foo')
    expect(projectSlug('/')).toBe('root')
    expect(projectSlug('/a b/c#d')).toBe('a-b-c-d')
    expect(stampName(Date.UTC(2026, 9, 4, 13, 5, 22, 500))).toBe('2026-10-04T13-05-22Z.md')
    const p = notePaths(DIR, PROJECT, Date.UTC(2026, 9, 4, 13, 5, 22))
    expect(p.folder).toBe(`${DIR}/${SLUG}`)
    expect(p.latest).toBe(`${DIR}/${SLUG}/latest.md`)
    expect(p.stamped).toBe(`${DIR}/${SLUG}/2026-10-04T13-05-22Z.md`)
  })

  test('gateReason: every blocking condition has a reason', async () => {
    const base = { percent: 80, threshold: 75, isTurnRunning: false, isPaused: false, inFlight: false, lastHandoverAt: null, cooldownMs: 600_000, now: 1_000_000 }
    expect(gateReason(base)).toBe(null)
    expect(gateReason({ ...base, isPaused: true })).toMatch(/paused/)
    expect(gateReason({ ...base, inFlight: true })).toMatch(/in progress/)
    expect(gateReason({ ...base, isTurnRunning: true })).toMatch(/turn/)
    expect(gateReason({ ...base, percent: null })).toMatch(/no usage reading/)
    expect(gateReason({ ...base, percent: 74 })).toMatch(/below the 75% threshold/)
    expect(gateReason({ ...base, lastHandoverAt: 1_000_000 - 60_000 })).toMatch(/cooling down/)
    expect(gateReason({ ...base, lastHandoverAt: 1_000_000 - 600_000 })).toBe(null)
    expect(gateReason({ ...base, isPaused: true }, 'ja')).toMatch(/一時停止中/)
  })

  test('note file: front block plus body, stripped back to the note', async () => {
    const meta = { project: PROJECT, sessionId: 's', nowMs: Date.UTC(2026, 9, 4), percent: 76, model: 'm', trigger: 'threshold' as const }
    const file = renderNoteFile(meta, NOTE)
    expect(file.startsWith('---\nproject: /home/u/code/proj\nsession: s\n')).toBe(true)
    expect(file).toMatch(/context_percent: 76\n/)
    expect(file).toMatch(/language: en\n/)
    expect(stripFrontMatter(file).trim()).toBe(NOTE)
    expect(ensureHeading('## Goal\nx')).toBe('# Handover note\n\n## Goal\nx')
    expect(ensureHeading('## 目的\nx', 'ja')).toBe('# 引き継ぎメモ\n\n## 目的\nx')
    expect(injectedMessage(NOTE, '/f.md')).toMatch(/the note wins[\s\S]*# Handover note[\s\S]*\(file: \/f\.md\)$/)
    expect(resumeBlock(file, 3_600_000, '~/f.md')).toMatch(/^The previous session left a handover note for this project 1h0m ago[\s\S]*# Handover note/)
    expect(resumeBlock(file, 0, '~/f.md')).not.toMatch(/project: /)
    expect(resumeBlock(file, 60_000, '~/f.md', 'zh-TW')).toMatch(/^上一個 session 在 1m 前/)
  })

  test('bandLine: no row while far from the threshold with no handover yet', async () => {
    const base = { percent: 30, threshold: 75, phase: 'idle' as const, last: null, failure: null, isPaused: false, now: 1_000_000, home: HOME }
    expect(bandLine(base)).toBe(null)
    expect(bandLine({ ...base, percent: 66 })).toEqual({ text: '⟲ context 66% / threshold 75%', tone: 'dim' })
    expect(bandLine({ ...base, phase: 'writing' })?.tone).toBe('warn')
    expect(bandLine({ ...base, failure: 'x' })).toEqual({ text: '⟲ auto-handover: x', tone: 'warn' })
    const rec = { at: 1_000_000 - 120_000, file: `${DIR}/${SLUG}/latest.md`, trigger: 'threshold' as const, percent: 80, percentAfter: 20 }
    expect(bandLine({ ...base, last: rec })?.text).toBe(`⟲ context 30% / threshold 75% · last handover 2m ago · ~/.claude/handovers/${SLUG}/latest.md`)
    expect(bandLine({ ...base, last: rec, isPaused: true })?.text).toMatch(/paused/)
    expect(bandLine({ ...base, percent: 66 }, 'ja')?.text).toBe('⟲ context 66% / しきい値 75%')
  })
})

// ── Integration ──────────────────────────────────────────────────────────────

describe('auto-handover', () => {
  test('over the threshold while idle: write note → save → compact (instructions carry the note) → append', async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 80)
    expect(w.compactCalls.length).toBe(0) // waits 1.5 s
    await w.clock.advance(1500)
    expect(w.forkPrompts.length).toBe(1)
    expect(w.forkPrompts[0]).toMatch(/# Handover note/)
    expect(w.writes.length).toBe(2)
    expect(w.writes[1]).toBe(`${DIR}/${SLUG}/latest.md`)
    expect(w.writes[0]).toMatch(new RegExp(`^${DIR}/${SLUG}/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z\\.md$`))
    expect(w.files.get(`${DIR}/${SLUG}/latest.md`)).toMatch(/^---\nproject: \/home\/u\/code\/proj\n[\s\S]*trigger: threshold\n[\s\S]*# Handover note/)
    expect(w.compactCalls.length).toBe(1)
    // The kit's event may carry no trigger; the real engine stamps `plugin`.
    expect(w.compactCalls[0]?.trigger === undefined || w.compactCalls[0]?.trigger === 'plugin').toBe(true)
    expect(w.compactCalls[0]?.instructions).toContain(compactInstructions('en'))
    expect(w.compactCalls[0]?.instructions).toContain('Switch the login flow to OAuth')
    expect(injectAttempts(w)).toBe(1)
    for (const text of w.appended) expect(text).toMatch(/the note wins[\s\S]*Switch the login flow to OAuth/)
    expect(w.toasts.some(x => /Handed over and compacted: 80% → 20%/.test(x))).toBe(true)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await bandTexts($, surface)
      expect(has(band, /last handover \d+s ago · ~\/\.claude\/handovers\/home-u-code-proj\/latest\.md/)).toBe(true)
      expect(has(band, /ENGINE_DEFAULT/)).toBe(true) // never swallows the bands below
    }
    expect(await command($, w)).toMatch(/1 handover\(s\) this session/)
  })

  test('language ja: Japanese prompt headings, band and status', { options: { language: 'ja' } }, async ($, on) => {
    const w = world(on, {}, { HOME, LANG: 'en_US.UTF-8' })
    await start($, w)
    await measure($, w, 68)
    expect(has(await bandTexts($), /⟲ context 68% \/ しきい値 75%/)).toBe(true)
    expect(await command($, w)).toMatch(/auto-handover：しきい値 75%/)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.forkPrompts[0]).toContain('# 引き継ぎメモ')
    expect(w.forkPrompts[0]).toContain('## 次の一手')
    expect(w.compactCalls[0]?.instructions).toContain(compactInstructions('ja'))
    expect(w.files.get(`${DIR}/${SLUG}/latest.md`)).toMatch(/language: ja\n/)
    expect(w.toasts.some(x => /引き継ぎと compact が完了/.test(x))).toBe(true)
  })

  test('language auto with LANG=zh_TW: Traditional Chinese headings in the prompt', async ($, on) => {
    const w = world(on, {}, { HOME, LANG: 'zh_TW.UTF-8' })
    await start($, w)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.forkPrompts[0]).toContain('# 交接筆記')
    expect(w.forkPrompts[0]).toContain('## 下一步（第一件事）')
    expect(await command($, w)).toMatch(/本 session 交接 1 次/)
  })

  test('language auto with LC_ALL=C overrides LANG: English', async ($, on) => {
    const w = world(on, {}, { HOME, LC_ALL: 'C', LANG: 'ja_JP.UTF-8' })
    await start($, w)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.forkPrompts[0]).toContain('# Handover note')
  })

  test('mid-turn: no compaction; acts once the turn ends', async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await measure($, w, 85)
    await w.clock.advance(10_000)
    expect(w.forkPrompts.length).toBe(0)
    expect(w.compactCalls.length).toBe(0)
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
  })

  test('cooldown: a still-high reading after compaction does not retrigger until the cooldown passes', async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
    await measure($, w, 80)
    await w.clock.advance(60_000)
    expect(w.compactCalls.length).toBe(1)
    await w.clock.advance(10 * 60_000)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(2)
  })

  test('below the threshold: nothing happens; the band appears within 10 points', async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 50)
    await w.clock.advance(5000)
    expect(w.forkPrompts).toEqual([])
    expect(await bandTexts($)).toEqual(['ENGINE_DEFAULT'])
    await measure($, w, 68)
    expect(has(await bandTexts($), /⟲ context 68% \/ threshold 75%/)).toBe(true)
    expect(await command($, w)).toMatch(/usage 68% is below the 75% threshold/)
  })

  test('custom threshold 50 applies', { options: { threshold: 50, cooldown_minutes: 0 } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 55)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
  })

  test('/handover off pauses; /handover now ignores the threshold; /handover show prints the note', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(await command($, w, 'off')).toMatch(/paused/)
    await measure($, w, 90)
    await w.clock.advance(5000)
    expect(w.compactCalls.length).toBe(0)
    await measure($, w, 30)
    expect(await command($, w, 'now')).toMatch(/handing over in about 1.5 s/)
    expect(w.compactCalls.length).toBe(0)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
    expect(w.files.get(`${DIR}/${SLUG}/latest.md`)).toMatch(/trigger: command/)
    const shown = await command($, w, 'show')
    expect(shown).toMatch(/^~\/\.claude\/handovers\/home-u-code-proj\/latest\.md\n\n# Handover note/)
    expect(shown).not.toMatch(/^---/m)
  })

  test('/handover now during a turn: explains, then hands over once the turn ends', async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(await command($, w, 'now')).toMatch(/a turn is running/)
    expect(w.compactCalls.length).toBe(0)
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
  })

  test('note failure: toast, no compaction, no retry during the backoff', async ($, on) => {
    const w = world(on, { forkReply: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } })
    await start($, w)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(0)
    expect(w.writes).toEqual([])
    expect(w.toasts.some(x => /could not write the note: API error \(overloaded 529\)/.test(x))).toBe(true)
    await measure($, w, 82)
    await w.clock.advance(5000)
    expect(w.forkPrompts.length).toBe(1)
  })

  test('compaction skipped: the note is still saved and recorded', async ($, on) => {
    const w = world(on, { compactReply: 'skip' })
    await start($, w)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.writes.length).toBe(2)
    expect(injectAttempts(w)).toBe(0)
    expect(w.toasts.some(x => /compaction was skipped: skipped by the test/.test(x))).toBe(true)
    expect(await command($, w)).toMatch(/1 handover\(s\) this session/)
  })

  test('compaction refused (a turn just started): retries after the next turn ends', async ($, on) => {
    const w = world(on, { compactReply: 'reject' })
    await start($, w)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
    expect(injectAttempts(w)).toBe(0)
    expect(w.logs.some(l => /compaction refused/.test(l))).toBe(true)
    w.compactReply = 'ok'
    await turn($, w, 't2')
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(2)
    expect(injectAttempts(w)).toBe(1)
  })

  test('inject_after_compact off: nothing appended after compaction', { options: { inject_after_compact: false } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
    expect(injectAttempts(w)).toBe(0)
  })

  test('manual /compact: a note first, instructions carry it, appended afterwards', async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 40)
    const out: any = await $.session.compact({ trigger: 'manual', instructions: 'keep the test plan', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
    await w.clock.settle()
    expect(out.skip).toBe(undefined)
    expect(w.forkPrompts.length).toBe(1)
    expect(w.files.get(`${DIR}/${SLUG}/latest.md`)).toMatch(/trigger: manual/)
    expect(w.compactCalls.length).toBe(1)
    expect(w.compactCalls[0]?.instructions).toMatch(/^keep the test plan\n\n/)
    expect(w.compactCalls[0]?.instructions).toContain('Switch the login flow to OAuth')
    expect(injectAttempts(w)).toBe(1)
    expect(w.toasts.some(x => /Handover note written/.test(x))).toBe(true)
  })

  test('new session: a fresh latest.md for the same project becomes a context block; too old or already handed over is skipped', async ($, on) => {
    const w = world(on)
    const latest = `${DIR}/${SLUG}/latest.md`
    w.files.set(latest, renderNoteFile({ project: PROJECT, sessionId: 'old', nowMs: 0, percent: 80, model: 'm', trigger: 'threshold' }, NOTE))
    w.mtimes.set(latest, w.clock.now() - 2 * 3_600_000)
    await start($, w)
    const ctx: any = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
    expect(ctx.blocks.map((b: any) => b.name)).toEqual(['currentDate', 'handover'])
    expect(ctx.blocks[1].text).toMatch(/^The previous session left a handover note for this project 2h0m ago[\s\S]*Switch the login flow to OAuth/)
    expect(ctx.blocks[1].text).not.toMatch(/^---/m)
    // too old
    w.mtimes.set(latest, w.clock.now() - 30 * 3_600_000)
    const old: any = await $.prompt.context({ blocks: [] })
    expect(old.blocks).toEqual([])
    // this session handed over itself: the note is already in the conversation
    w.mtimes.set(latest, w.clock.now())
    await measure($, w, 80)
    await w.clock.advance(1500)
    expect(w.compactCalls.length).toBe(1)
    const after: any = await $.prompt.context({ blocks: [] })
    expect(after.blocks).toEqual([])
  })

  test('resume_hours 0: no context block', { options: { resume_hours: 0 } }, async ($, on) => {
    const w = world(on)
    const latest = `${DIR}/${SLUG}/latest.md`
    w.files.set(latest, NOTE)
    w.mtimes.set(latest, w.clock.now())
    await start($, w)
    const ctx: any = await $.prompt.context({ blocks: [] })
    expect(ctx.blocks).toEqual([])
  })

  test('safety: no home directory disables everything, no model call, no file', async ($, on) => {
    const w = world(on, {}, {})
    await start($, w)
    await measure($, w, 90)
    await w.clock.advance(5000)
    expect(w.forkPrompts).toEqual([])
    expect(w.writes).toEqual([])
    expect(has(await bandTexts($), /cannot find your home directory/)).toBe(true)
  })

  test('safety: a handover_dir outside the home directory is refused', { options: { handover_dir: '/tmp/handovers' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 90)
    await w.clock.advance(5000)
    expect(w.writes).toEqual([])
    expect(w.compactCalls.length).toBe(0)
    expect(has(await bandTexts($), /outside your home directory/)).toBe(true)
  })

  // The band's frame: a rounded box, dim normally and yellow while the line is a warning.
  async function frames($: any): Promise<{ boxes: any[]; texts: string[] }> {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    const boxes = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.borderStyle === 'round')
    const found = await ui.findAll({ type: 'Text' })
    await ui.unmount()
    return { boxes, texts: found.map((x: any) => String(x.text ?? '')) }
  }

  test('band_style=box (default): dim frame near the threshold, yellow frame on a warning, no rule', async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 70)
    let f = await frames($)
    expect(f.boxes.length).toBe(1)
    expect(f.boxes[0]?.props?.borderDimColor).toBe(true)
    expect(f.boxes[0]?.props?.borderColor).toBe(undefined)
    expect(has(f.texts, /^─+$/)).toBe(false)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
    void w
  })

  test('band_style=box: the frame is yellow while the band line is a warning', { options: { handover_dir: '/tmp/handovers' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    const f = await frames($)
    expect(has(f.texts, /outside your home directory/)).toBe(true)
    expect(f.boxes.length).toBe(1)
    expect(f.boxes[0]?.props?.borderColor).toBe('yellow')
    expect(f.boxes[0]?.props?.borderDimColor).toBe(undefined)
  })

  test('band_style=rule and plain', { options: { band_style: 'rule' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 70)
    const f = await frames($)
    expect(f.boxes.length).toBe(0)
    expect(has(f.texts, /^─+$/)).toBe(true)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
  })

  test('band_style=plain draws neither frame nor rule', { options: { band_style: 'plain' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await measure($, w, 70)
    const f = await frames($)
    expect(f.boxes.length).toBe(0)
    expect(has(f.texts, /^─+$/)).toBe(false)
    expect(has(f.texts, /⟲ context 70%/)).toBe(true)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
  })

  test('non-interactive (-p) session: no automatic handover', async ($, on) => {
    const w = world(on)
    await start($, w, false)
    await measure($, w, 90)
    await w.clock.advance(5000)
    expect(w.compactCalls.length).toBe(0)
  })
})
