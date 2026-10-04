// opsx-board behaviour tests: `claude plugin test plugins/opsx-board`
//
// The test's `on` sits beneath every plugin and stands for the engine: the file system,
// tool execution, agent spawn and completion are all faked here.

import { describe, expect, mock, test } from 'claude-code/testing'

import { LANGS, MESSAGES, resolveLang, t } from '../hooks/i18n'
import {
  bandText,
  changeFromPath,
  duration,
  flippedDone,
  fmt,
  isTasksFile,
  markDone,
  newAgent,
  paneModel,
  parseOpenspecBash,
  parseTasks,
  phaseFromCommand,
  phaseFromSkill,
  shortModel,
} from '../hooks/logic'
import type { Tasks } from '../types'

const ROOT = '/home/u/proj'
const CHANGE = 'add-auth'
const TASKS = `${ROOT}/openspec/changes/${CHANGE}/tasks.md`

const TASKS_MD = `# Tasks

## 1. Schema

- [x] 1.1 Add users table
- [ ] 1.2 Add migration

## 2. API

- [ ] 2.1 Implement /login
- [ ] 2.2 Implement /me
`

type World = {
  files: Map<string, string>
  writes: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
  closed: string[]
  agentList: unknown[]
  clock: ReturnType<typeof mock.clock>
}

function world(on: any, files: Record<string, string> = {}, env: Record<string, string> = {}): World {
  const w: World = {
    files: new Map(Object.entries(files)),
    writes: [],
    toasts: [],
    statuses: [],
    opened: [],
    closed: [],
    agentList: [],
    clock: mock.clock(on, { now: 1_000_000 }),
  }
  mock.env(on, env)
  const value = (v: unknown) => ({ value: v })
  on('session.root', () => value(ROOT))
  on('session.cwd', () => value(ROOT))
  on('fs.read', (_$: any, e: any) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : value(text)
  })
  on('fs.write', (_$: any, e: any) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return value(undefined)
  })
  on('fs.exists', (_$: any, e: any) => value(w.files.has(e.path)))
  on('fs.list', (_$: any, e: any) => {
    const names = new Set<string>()
    for (const f of w.files.keys()) {
      if (!f.startsWith(`${e.path}/`)) continue
      const rest = f.slice(e.path.length + 1)
      const head = rest.split('/')[0] ?? ''
      if (head) names.add(head + (rest.includes('/') ? '/' : ''))
    }
    return value([...names].map(n => ({ name: n.replace(/\/$/, ''), kind: n.endsWith('/') ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false })))
  })
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('tool.register', (_$: any, e: any) => value({ tool: `mcp__opsx-board__${e.name}` }))
  on('agent.list', () => value(w.agentList))
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e))
    return value(undefined)
  })
  on('ui.status', (_$: any, e: any) => {
    w.statuses.push(e.text)
    return value(undefined)
  })
  on('ui.open', (_$: any, e: any) => {
    w.opened.push(e.id)
    return value({ isPlaced: true })
  })
  on('ui.close', (_$: any, e: any) => {
    w.closed.push(e.id)
    return value(undefined)
  })
  // The engine's own drawing: catches a plugin's next(e)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  // The real tools: Read answers file content, Edit / Write change the fake file system
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'Read') {
      const text = w.files.get(e.file_path)
      return text === undefined ? { result: { error: 'ENOENT' }, text: 'ENOENT', isError: true } : { result: { file: { content: text } }, text }
    }
    if (e.tool === 'Write') {
      w.files.set(e.file_path, e.content)
      return { result: { type: 'create' }, text: 'ok' }
    }
    if (e.tool === 'Edit') {
      const text = w.files.get(e.file_path) ?? ''
      w.files.set(e.file_path, e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, e.new_string))
      return { result: { type: 'update' }, text: 'ok' }
    }
    return { result: { ok: true }, text: 'ok' }
  })
  on('command.run', () => ({ text: '' }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'INTRO', scope: 'shared' }] }))
  on('agent.spawn', (_$: any, e: any) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.description}` }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('turn.step', async function* (_$: any, e: any) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Grep', input: { pattern: 'refreshToken' } }],
      stopReason: 'tool_use',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
    }
  })
  return w
}

async function start($: any, on: any, w: World): Promise<void> {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

async function cmd($: any, w: World, command: string, args = ''): Promise<string> {
  const r: any = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  await w.clock.settle()
  return String(r?.text ?? '')
}

const BAND = { plugin: 'opsx-board', component: 'AbovePrompt', props: {} } as const
const PANE = { plugin: 'opsx-board', component: 'Pane', requestId: 'opsx-board', props: {} } as const

async function texts($: any, spec: object, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...spec, surface } as any)
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return found.map((x: any) => String(x.text ?? ''))
}

const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l))

async function spawn($: any, description: string, type = 'Explore'): Promise<string> {
  const r: any = await $.agent.spawn({
    tool_use_id: `tu-${description}`,
    prompt: 'do it',
    description,
    subagentType: type,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-fable-5-1',
    background: false,
    fork: false,
  } as any)
  return r.agentId
}

async function step($: any, agentId: string, index = 0): Promise<void> {
  const s: any = $.turn.step({ turnId: `t-${agentId}`, index, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1, agentId } as any)
  for await (const _chunk of s) {
    /* no chunks; just drain the stream */
  }
  await s.result
}

async function complete($: any, agentId: string, reason: 'answer' | 'error' | 'aborted' = 'answer'): Promise<void> {
  await $.turn.complete({
    turnId: `t-${agentId}`,
    agentId,
    answer: 'done',
    durationMs: 72_000,
    isAborted: reason === 'aborted',
    reason,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
  } as any)
}

// ── Pure functions ─────────────────────────────────────────────────────────

describe('i18n', () => {
  test('resolveLang: explicit option wins, else LC_ALL > LC_MESSAGES > LANG, zh* → zh-TW, ja* → ja, C/POSIX/empty → en', async () => {
    expect(resolveLang('ja', { LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('zh-TW', {})).toBe('zh-TW')
    expect(resolveLang('en', { LC_ALL: 'ja_JP.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: 'ja_JP.UTF-8', LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'ja_JP' })).toBe('zh-TW')
    expect(resolveLang(undefined, { LANG: 'zh_TW.UTF-8' })).toBe('zh-TW')
    expect(resolveLang('auto', { LANG: 'ja_JP.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LANG: 'en_US.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LANG: 'fr_FR.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LANG: 'C' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: 'POSIX', LANG: 'ja_JP' })).toBe('en')
    expect(resolveLang('auto', { LANG: '' })).toBe('en')
    expect(resolveLang('auto', {})).toBe('en')
    expect(resolveLang('klingon', { LANG: 'ja_JP' })).toBe('ja')
  })

  test('every message key exists in every language and renders', async () => {
    const keys = Object.keys(MESSAGES.en)
    for (const lang of LANGS) {
      for (const key of keys) {
        expect(typeof MESSAGES[lang][key as keyof typeof MESSAGES.en]).not.toBe('undefined')
        const s = t(lang, key as keyof typeof MESSAGES.en, { n: 2, d: '3s', name: 'x', type: 'T', tok: '1k', reason: 'r', id: '1', title: 't', progress: '1/2', tool: 'Read', file: 'f', label: 'L', s: 1 })
        expect(typeof s).toBe('string')
        expect(s.length).toBeGreaterThan(0)
      }
    }
    expect(t('ja', 'group.running')).toBe('実行中')
    expect(t('zh-TW', 'agent.ranFor', { d: '42s' })).toBe('跑了 42s')
    expect(t('en', 'band.running', { n: 1 })).toBe('⚇ 1 agent running')
    expect(t('en', 'band.running', { n: 2 })).toBe('⚇ 2 agents running')
  })
})

describe('logic', () => {
  test('parseTasks: sections, ids, checkbox state and line numbers', async () => {
    const { items, sections } = parseTasks(TASKS_MD)
    expect(sections.map(s => s.title)).toEqual(['1. Schema', '2. API'])
    expect(items.map(i => i.id)).toEqual(['1.1', '1.2', '2.1', '2.2'])
    expect(items[0]?.done).toBe(true)
    expect(items[1]).toEqual({ id: '1.2', title: 'Add migration', done: false, line: 5, section: '1. Schema' })
    expect(parseTasks('- [X] 3 upper-case counts\n* [ ] 4.1.2 three levels').items.map(i => [i.id, i.done])).toEqual([['3', true], ['4.1.2', false]])
  })

  test('markDone changes only that line; flippedDone counts tasks flipped to done', async () => {
    const m = markDone(TASKS_MD, '1.2')
    expect(m.found && m.changed).toBe(true)
    expect(m.text.split('\n')[5]).toBe('- [x] 1.2 Add migration')
    expect(m.text.split('\n')[9]).toBe('- [ ] 2.1 Implement /login')
    expect(markDone(TASKS_MD, '1.1')).toEqual({ text: TASKS_MD, changed: false, found: true })
    expect(markDone(TASKS_MD, '9.9').found).toBe(false)
    const before = parseTasks(TASKS_MD).items
    const after = parseTasks(TASKS_MD.replace(/\[ \]/g, '[x]')).items
    expect(flippedDone(before, after)).toBe(3)
    expect(flippedDone(before, parseTasks(m.text).items)).toBe(1)
  })

  test('phase detection: command, skill, path, Bash', async () => {
    expect(phaseFromCommand('opsx:apply', 'add-auth --force')).toEqual({ kind: 'apply', change: 'add-auth' })
    expect(phaseFromCommand('opsx:propose', '')).toEqual({ kind: 'propose', change: null })
    expect(phaseFromCommand('compact', '')).toBe(null)
    expect(phaseFromSkill('openspec-apply-change')).toBe('apply')
    expect(phaseFromSkill('openspec-sync-specs')).toBe('sync')
    expect(phaseFromSkill('commit')).toBe(null)
    expect(changeFromPath('/p/openspec/changes/add-auth/design.md')).toBe('add-auth')
    expect(changeFromPath('/p/openspec/changes/archive/2026-10-04-x/tasks.md')).toBe(null)
    expect(isTasksFile('/p/openspec/changes/add-auth/tasks.md')).toBe(true)
    expect(isTasksFile('/p/openspec/changes/add-auth/proposal.md')).toBe(false)
    expect(parseOpenspecBash('openspec status --change "add-auth" --json')).toEqual({ sub: 'status', change: 'add-auth' })
    expect(parseOpenspecBash('cd x && openspec instructions apply --change add-auth --json')).toEqual({ sub: 'instructions', change: 'add-auth' })
    expect(parseOpenspecBash('openspec archive add-auth --yes')).toEqual({ sub: 'archive', change: 'add-auth' })
    expect(parseOpenspecBash('openspec list --json')).toEqual({ sub: 'list', change: null })
    expect(parseOpenspecBash('npm test')).toBe(null)
  })

  test('formatting: tokens, durations, model short names', async () => {
    expect(fmt(999)).toBe('999')
    expect(fmt(12_400)).toBe('12k')
    expect(fmt(1_234)).toBe('1.2k')
    expect(fmt(1_200_000)).toBe('1.2M')
    expect(duration(42_000)).toBe('42s')
    expect(duration(72_000)).toBe('1m12s')
    expect(duration(3_900_000)).toBe('1h05m')
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(shortModel('us.anthropic.claude-opus-5-5')).toBe('opus')
    expect(shortModel('gpt-x')).toBe('gpt-x')
  })

  test('band and pane: phase, current task, agent groups, in three languages', async () => {
    const parsed = parseTasks(TASKS_MD)
    const tasks: Tasks = { file: TASKS, change: CHANGE, items: parsed.items, sections: parsed.sections, current: null, updatedAt: 0 }
    const phase = { kind: 'apply', change: CHANGE, since: 0 }
    const running = newAgent({ id: 'a', description: 'Search code', type: 'Explore', model: 'claude-sonnet-5-5', background: false, now: 0 })
    const done = { ...newAgent({ id: 'b', description: 'Run tests', type: 'general-purpose', model: 'claude-opus-5-5', background: false, now: 0 }), status: 'failed' as const, endedAt: 5000, failReason: 'error', output: 1500 }
    expect(bandText('en', phase, tasks, {}, 1000, 4000)).toBe('⧉ opsx apply add-auth · 1.2 Add migration · 1/4 · 3s ago')
    expect(bandText('zh-TW', phase, tasks, {}, 1000, 4000)).toBe('⧉ opsx apply add-auth · 1.2 Add migration · 1/4 · 3s 前')
    expect(bandText('ja', phase, tasks, {}, 1000, 4000)).toBe('⧉ opsx apply add-auth · 1.2 Add migration · 1/4 · 3s前')
    expect(bandText('en', { kind: 'idle', change: null, since: 0 }, null, {}, 0, 0)).toBe(null)
    expect(bandText('en', { kind: 'idle', change: null, since: 0 }, null, { a: running, b: done }, 0, 0)).toBe('⚇ 1 agent running · 1 done · 1.5k tok')
    expect(bandText('zh-TW', { kind: 'idle', change: null, since: 0 }, null, { a: running, b: done }, 0, 0)).toBe('⚇ 1 agent 跑著 · 1 做完 · 1.5k tok')
    const rows = paneModel('en', phase, { ...tasks, current: '2.1' }, { a: running, b: done }, 42_000).map(r => r.text)
    expect(rows[0]).toBe('OpenSpec · apply · add-auth  ▓▓▓░░░░░░░ 1/4')
    expect(rows[1]).toBe('▶ 2.1 Implement /login')
    expect(rows[2]).toBe('  ○ 1.2 Add migration   ○ 2.2 Implement /me')
    expect(rows).toContain('● running (1)')
    expect(rows).toContain('  ▶ Search code · Explore · sonnet · 0 tok · running 42s')
    expect(rows).toContain('○ done (1)')
    expect(rows).toContain('  ✗ Run tests · general-purpose · opus · 1.5k tok · failed: error')
    expect(rows.some(r => r.includes('waiting ('))).toBe(false)
    const ja = paneModel('ja', phase, { ...tasks, current: '2.1' }, { a: running, b: done }, 42_000).map(r => r.text)
    expect(ja).toContain('● 実行中（1）')
    expect(ja).toContain('  ▶ Search code · Explore · sonnet · 0 tok · 42s 経過')
    expect(ja).toContain('  ✗ Run tests · general-purpose · opus · 1.5k tok · 失敗：error')
    const zh = paneModel('zh-TW', phase, tasks, {}, 0).map(r => r.text)
    expect(zh[1]).toBe('▶ 1.2 Add migration（推斷）')
  })
})

// ── Integration ────────────────────────────────────────────────────────────

describe('opsx-board', () => {
  test('/opsx:apply <change>: reads tasks.md; band, status line and system prompt follow', async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD })
    await start($, on, w)
    await cmd($, w, 'opsx:apply', CHANGE)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await texts($, BAND, surface)
      expect(has(band, /^⧉ opsx apply add-auth · 1\.2 Add migration · 1\/4/)).toBe(true)
      // The band stacks above the plugins beneath, never swallowing their bands
      expect(has(band, /ENGINE_DEFAULT/)).toBe(true)
    }
    expect(w.statuses.at(-1)).toBe('opsx apply add-auth · 1.2 · 1/4')
    // The apply phase opens the pane by itself
    expect(w.opened).toEqual(['opsx-board'])
    const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
    expect(composed.sections.map((s: any) => s.id)).toEqual(['intro', 'opsx-board:apply'])
    expect(composed.sections[1].scope).toBe('session')
    expect(composed.sections[1].text).toMatch(/^# opsx-board: task reporting rule/)
    const pane = await texts($, PANE)
    expect(has(pane, /^OpenSpec · apply · add-auth/)).toBe(true)
    expect(has(pane, /^▶ 1\.2 Add migration \(inferred\)/)).toBe(true)
  })

  test('task tool: start declares the current task, done ticks tasks.md through the mod', async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD })
    await start($, on, w)
    await cmd($, w, 'opsx:apply', CHANGE)
    const started: any = await $.tool.call({ tool: 'mcp__opsx-board__task', task_id: '2.1', status: 'start' } as any)
    expect(started.result).toEqual({ ok: true, task: '2.1 Implement /login', progress: '1/4' })
    expect(has(await texts($, PANE), /^▶ 2\.1 Implement \/login$/)).toBe(true)
    expect(w.statuses.at(-1)).toBe('opsx apply add-auth · 2.1 · 1/4')
    const done: any = await $.tool.call({ tool: 'mcp__opsx-board__task', task_id: '2.1', status: 'done' } as any)
    expect(done.result).toEqual({ ok: true, marked: true, progress: '2/4', next: '1.2 Add migration', all_done: false })
    expect(w.writes).toEqual([TASKS])
    expect(w.files.get(TASKS)?.split('\n')[9]).toBe('- [x] 2.1 Implement /login')
    expect(w.toasts.at(-1)).toMatch(/✓ 2\.1 Implement \/login · 2\/4/)
    const unknown: any = await $.tool.call({ tool: 'mcp__opsx-board__task', task_id: '9.9', status: 'done' } as any)
    expect(unknown.result.ok).toBe(false)
    expect(unknown.result.error).toBe('No task numbered 9.9 in tasks.md.')
    expect(unknown.result.known).toEqual(['1.2', '2.2'])
  })

  test('task tool: with no change known yet, a single active change is used', async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD, [`${ROOT}/openspec/changes/archive/old/tasks.md`]: '- [ ] 1 x' })
    await start($, on, w)
    const r: any = await $.tool.call({ tool: 'mcp__opsx-board__task', task_id: '1.2', status: 'done' } as any)
    expect(r.result.ok).toBe(true)
    expect(w.files.get(TASKS)).toContain('- [x] 1.2 Add migration')
    expect(has(await texts($, BAND), /⧉ opsx apply add-auth · 2\.1 Implement \/login · 2\/4/)).toBe(true)
  })

  test('editing tasks.md directly: one tick passes; several ticks at once get a reminder', async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD })
    await start($, on, w)
    const one: any = await $.tool.call({ tool: 'Edit', file_path: TASKS, old_string: '- [ ] 1.2', new_string: '- [x] 1.2' } as any)
    expect(one.deny).toBe(undefined)
    expect(one.context).toBe(undefined)
    expect(has(await texts($, BAND), /⧉ opsx apply add-auth · 2\.1 Implement \/login · 2\/4/)).toBe(true)
    const many: any = await $.tool.call({ tool: 'Edit', file_path: TASKS, old_string: '[ ]', new_string: '[x]', replace_all: true } as any)
    expect(many.deny).toBe(undefined)
    expect(many.context?.[0]).toMatch(/marked 2 tasks done at once/)
    expect(has(await texts($, PANE), /✓ All tasks done/)).toBe(true)
  })

  test('strict mode: an edit ticking several tasks is refused and the file is untouched', { options: { strict: true } }, async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD })
    await start($, on, w)
    const r: any = await $.tool.call({ tool: 'Write', file_path: TASKS, content: TASKS_MD.replace(/\[ \]/g, '[x]') } as any)
    expect(r.deny).toMatch(/strict mode/)
    expect(w.files.get(TASKS)).toBe(TASKS_MD)
    const one: any = await $.tool.call({ tool: 'Edit', file_path: TASKS, old_string: '- [ ] 1.2', new_string: '- [x] 1.2' } as any)
    expect(one.deny).toBe(undefined)
  })

  test('the openspec-apply-change skill text gets the reporting rule appended; not with injection off', async ($, on) => {
    const w = world(on)
    await start($, on, w)
    const r: any = await $.skill.prompt({ skill: 'openspec-apply-change', text: 'SKILL' } as any)
    expect(r.text.startsWith('SKILL\n\n# opsx-board')).toBe(true)
    expect(r.text).toMatch(/mcp__opsx-board__task/)
    const other: any = await $.skill.prompt({ skill: 'openspec-propose', text: 'P' } as any)
    expect(other.text).toBe('P')
    expect(has(await texts($, BAND), /^⧉ opsx propose/)).toBe(true)
  })

  test('inject_instructions=false: neither the skill nor the system prompt is changed', { options: { inject_instructions: false } }, async ($, on) => {
    const w = world(on)
    await start($, on, w)
    const r: any = await $.skill.prompt({ skill: 'openspec-apply-change', text: 'SKILL' } as any)
    expect(r.text).toBe('SKILL')
    const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
    expect(composed.sections.map((s: any) => s.id)).toEqual(['intro'])
  })

  test('openspec in Bash: status yields the change, a successful archive returns to idle', async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD })
    await start($, on, w)
    await $.tool.call({ tool: 'Bash', command: `openspec status --change "${CHANGE}" --json` } as any)
    expect(has(await texts($, BAND), /⧉ opsx/)).toBe(false) // change known, phase not: no row yet
    await $.tool.call({ tool: 'Read', file_path: TASKS } as any)
    // tasks.md read, no phase entered: the band shows the change name without claiming apply
    expect(has(await texts($, BAND), /^⧉ opsx add-auth · 1\.2 Add migration · 1\/4/)).toBe(true)
    expect(w.statuses.at(-1)).toBe('opsx add-auth · 1.2 · 1/4')
    await $.tool.call({ tool: 'Bash', command: `openspec archive ${CHANGE} --yes` } as any)
    expect(await texts($, BAND)).toEqual(['ENGINE_DEFAULT'])
    expect(w.statuses.at(-1)).toBe(undefined)
  })

  test('sub agent: spawn → step → tool → complete; pane and toasts follow', async ($, on) => {
    const w = world(on)
    await start($, on, w)
    const a1 = await spawn($, 'Search auth code')
    expect(a1).toBe('agent-Search auth code')
    expect(w.toasts).toEqual(['▶ Search auth code started (Explore)'])
    expect(w.opened).toEqual(['opsx-board'])
    await step($, a1, 0)
    await step($, a1, 1)
    await $.tool.call({ tool: 'Read', file_path: '/x/auth.ts', agentId: a1 } as any)
    await w.clock.advance(42_000)
    let pane = await texts($, PANE)
    expect(has(pane, /^Sub agents · 1 this session · 12k tok total/)).toBe(true)
    expect(has(pane, /^ {2}▶ Search auth code · Explore · sonnet\/medium · 12k tok · running 42s$/)).toBe(true)
    expect(has(pane, /^ {6}step 2 · 1 tools · last Read auth\.ts · ↑12k ↓400$/)).toBe(true)
    expect(has(await texts($, BAND), /⚇ 1 agent running · 12k tok/)).toBe(true)
    await complete($, a1, 'answer')
    expect(w.toasts.at(-1)).toBe('✓ Search auth code done · 12k tok · 42s')
    const a2 = await spawn($, 'Run e2e', 'general-purpose')
    await complete($, a2, 'error')
    expect(w.toasts.at(-1)).toBe('✗ Run e2e failed: error')
    pane = await texts($, PANE)
    expect(has(pane, /^○ done \(2\)/)).toBe(true)
    expect(has(pane, /^ {2}✓ Search auth code · Explore · sonnet\/medium · 12k tok · 42s$/)).toBe(true)
    // An agent with no turn.step takes its usage from turn.complete
    expect(has(pane, /^ {2}✗ Run e2e · general-purpose · sonnet · 15 tok · failed: error$/)).toBe(true)
    expect(has(await texts($, BAND), /⚇ 2 agents done · 12k tok/)).toBe(true)
    expect(await cmd($, w, 'opsx-board', 'clear')).toMatch(/cleared/)
    expect(has(await texts($, PANE), /Sub agents · none yet/)).toBe(true)
  })

  test('agent.list reporting waiting moves the agent to the waiting group', async ($, on) => {
    const w = world(on)
    await start($, on, w)
    const a1 = await spawn($, 'Await approval')
    w.agentList = [{ id: a1, description: 'Await approval', type: 'Explore', status: 'waiting' }]
    await w.clock.advance(5_000)
    const pane = await texts($, PANE)
    expect(has(pane, /^◐ waiting \(1\)/)).toBe(true)
    expect(has(pane, /^ {2}⏸ Await approval · Explore · sonnet · 0 tok · waiting 5s$/)).toBe(true)
  })

  test('/opsx-board: toggles the pane, off hides everything, demo shows fake data', async ($, on) => {
    const w = world(on)
    await start($, on, w)
    expect(await cmd($, w, 'opsx-board')).toMatch(/opened/)
    expect(await cmd($, w, 'opsx-board')).toMatch(/closed/)
    expect(w.closed).toEqual(['opsx-board'])
    await cmd($, w, 'opsx:apply', CHANGE)
    expect(await cmd($, w, 'opsx-board', 'off')).toMatch(/paused/)
    expect(await texts($, BAND)).toEqual(['ENGINE_DEFAULT'])
    expect(w.statuses.at(-1)).toBe(undefined)
    expect(await cmd($, w, 'opsx-board', 'demo')).toMatch(/demo mode/)
    const pane = await texts($, PANE)
    expect(has(pane, /demo mode/)).toBe(true)
    expect(has(pane, /^▶ 3\.2 Implement token refresh$/)).toBe(true)
    expect(has(pane, /Write unit tests · general-purpose · opus\/high/)).toBe(true)
    expect(has(await texts($, BAND), /⧉ opsx apply add-auth · 3\.2 Implement token refresh · 5\/9 · ⚇ 2 agents running/)).toBe(true)
    expect(w.writes).toEqual([])
  })

  test('language=ja: band, pane, toasts, command output and the model-facing rule are Japanese', { options: { language: 'ja' } }, async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD }, { LANG: 'en_US.UTF-8' })
    await start($, on, w)
    await cmd($, w, 'opsx:apply', CHANGE)
    expect(has(await texts($, PANE), /^▶ 1\.2 Add migration（推定）/)).toBe(true)
    const a1 = await spawn($, 'Search auth code')
    expect(w.toasts.at(-1)).toBe('▶ Search auth code 開始（Explore）')
    await w.clock.advance(42_000)
    expect(has(await texts($, BAND), /⚇ 1 agent 実行中 · 0 tok · 42s前/)).toBe(true)
    expect(has(await texts($, PANE), /^● 実行中（1）/)).toBe(true)
    await complete($, a1, 'answer')
    expect(w.toasts.at(-1)).toBe('✓ Search auth code 完了 · 15 tok · 42s')
    expect(await cmd($, w, 'opsx-board', 'clear')).toMatch(/消去/)
    const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
    expect(composed.sections[1].text).toMatch(/^# opsx-board：タスク報告ルール/)
    expect(composed.sections[1].text).toMatch(/mcp__opsx-board__task/)
  })

  test('language=auto with LANG=zh_TW.UTF-8 renders Traditional Chinese', { options: { language: 'auto' } }, async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD }, { LANG: 'zh_TW.UTF-8' })
    await start($, on, w)
    await cmd($, w, 'opsx:apply', CHANGE)
    expect(has(await texts($, PANE), /^▶ 1\.2 Add migration（推斷）/)).toBe(true)
    expect(await cmd($, w, 'opsx-board', 'off')).toMatch(/已暫停/)
    const r: any = await $.skill.prompt({ skill: 'openspec-apply-change', text: 'SKILL' } as any)
    expect(r.text).toMatch(/# opsx-board：任務回報規則/)
  })

  test('language=auto with no locale falls back to English', async ($, on) => {
    const w = world(on, { [TASKS]: TASKS_MD })
    await start($, on, w)
    await cmd($, w, 'opsx:apply', CHANGE)
    expect(has(await texts($, PANE), /^▶ 1\.2 Add migration \(inferred\)/)).toBe(true)
  })
})
