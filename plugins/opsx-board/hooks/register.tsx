// opsx-board: a board for the OpenSpec workflow and this session's sub agents.
//
// - Phase: read off /opsx:<kind> commands, openspec-<kind> skills, `openspec` commands in
//   Bash, and file paths under openspec/changes/<change>/, to tell propose / apply / archive apart.
// - Tasks: tracks openspec/changes/<change>/tasks.md, shows the current task and progress;
//   gives the model an mcp__opsx-board__task tool to report start / done per task, and ticks
//   [x] itself on done. An Edit / Write that ticks several tasks at once gets a reminder
//   (or is refused in strict mode).
// - Sub agents: agent.spawn / turn.step / tool.call / turn.complete build one row per agent:
//   name, type, model/effort, tokens, steps, last action and status.
// - Language: every string a person or the model reads goes through hooks/i18n.ts; the
//   `language` setting picks en / zh-TW / ja, or `auto` reads LC_ALL / LC_MESSAGES / LANG.
// - The only file it writes is one checkbox line of tasks.md. No network, no model calls,
//   no external commands.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, Phase, Tasks } from '../types'
import { DEMO_AGENTS, DEMO_NOW, DEMO_PHASE, DEMO_TASKS } from './demo'
import { DEFAULT_LANG, resolveLang, t } from './i18n'
import type { Lang } from './i18n'
import {
  IDLE_PHASE,
  IDLE_REDRAW_TICKS,
  LIST_TICKS,
  PANE,
  TICK_MS,
  TOAST_MS,
  addUsage,
  applyRule,
  bandText,
  changeFromPath,
  currentTask,
  detailOf,
  endToast,
  flippedDone,
  hasSomething,
  isTasksFile,
  markDone,
  newAgent,
  nudgeText,
  paneModel,
  parseOpenspecBash,
  parseTasks,
  phaseFromCommand,
  phaseFromSkill,
  progressOf,
  pruneAgents,
  simulateEdit,
  spawnToast,
  statusFromReason,
  statusText,
  strictDenyText,
  tasksPathOf,
  toolDescription,
  truncate,
} from './logic'
import type { PaneRow } from './logic'

const phase = atom({ plugin: 'opsx-board', key: 'phase' } as const, IDLE_PHASE)
const tasks = atom({ plugin: 'opsx-board', key: 'tasks' } as const, null)
const agents = atom({ plugin: 'opsx-board', key: 'agents' } as const, {})
const isPaneOpen = atom({ plugin: 'opsx-board', key: 'isPaneOpen' } as const, false)
const isPaused = atom({ plugin: 'opsx-board', key: 'isPaused' } as const, false)
const isDemo = atom({ plugin: 'opsx-board', key: 'isDemo' } as const, false)
const updatedAt = atom({ plugin: 'opsx-board', key: 'updatedAt' } as const, 0)
const tickAt = atom({ plugin: 'opsx-board', key: 'tickAt' } as const, 0)
const langState = atom({ plugin: 'opsx-board', key: 'lang' } as const, DEFAULT_LANG)

// Settings (read in register; a hot reload re-reads them)
let strict = false
let inject = true
let autoOpen = true
let langOption: unknown = 'auto'
// Module-level state: a hot reload resets it, which is fine
let lang: Lang = DEFAULT_LANG
let ticks = 0
let autoOpened = false

function toast($: any, text: string): void {
  try {
    $.ui.toast(text, { timeoutMs: TOAST_MS })
  } catch {}
}

async function touch($: any): Promise<void> {
  const now = await $.clock.now()
  await update($, updatedAt, () => now)
}

async function refreshStatus($: any): Promise<void> {
  if (await read($, isPaused)) return $.ui.status(undefined)
  $.ui.status(statusText(await read($, phase), await read($, tasks)))
}

// ── Phase ──────────────────────────────────────────────────────────────────

async function setPhase($: any, kind: string | null, change: string | null): Promise<void> {
  const prev = await read($, phase)
  const nextKind = kind ?? prev.kind
  const nextChange = change ?? (nextKind === prev.kind ? prev.change : null) ?? prev.change
  if (nextKind === prev.kind && nextChange === prev.change) return
  const now = await $.clock.now()
  const next: Phase = { kind: nextKind, change: nextChange, since: nextKind === prev.kind ? prev.since : now }
  await update($, phase, () => next)
  // A different change drops the old task list
  const cur = await read($, tasks)
  if (cur && nextChange && cur.change !== nextChange) await update($, tasks, () => null)
  await update($, updatedAt, () => now)
  await refreshStatus($)
  if (nextKind === 'apply' && nextChange) await loadTasks($, nextChange).catch(() => {})
  if (nextKind === 'apply' && autoOpen && !autoOpened) {
    autoOpened = true
    void openPane($, { asked: false }).catch(() => {})
  }
}

async function clearPhase($: any): Promise<void> {
  const now = await $.clock.now()
  await update($, phase, () => IDLE_PHASE)
  await update($, tasks, () => null)
  await update($, updatedAt, () => now)
  await refreshStatus($)
}

// ── tasks.md ───────────────────────────────────────────────────────────────

async function applyTasksText($: any, file: string, change: string, text: string, keepCurrent = true): Promise<Tasks> {
  const parsed = parseTasks(text)
  const prev = await read($, tasks)
  const now = await $.clock.now()
  const next: Tasks = {
    file,
    change,
    items: parsed.items,
    sections: parsed.sections,
    current: keepCurrent && prev && prev.file === file ? prev.current : null,
    updatedAt: now,
  }
  await update($, tasks, () => next)
  await update($, updatedAt, () => now)
  await refreshStatus($)
  return next
}

/** Reads a change's tasks.md; silently gives up when there is none */
async function loadTasks($: any, change: string): Promise<Tasks | null> {
  const file = tasksPathOf(await $.session.root(), change)
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    return null
  }
  return applyTasksText($, file, change, text)
}

/** The tasks.md to use: the tracked one, the current change's, or the only active change's */
async function resolveTasksFile($: any): Promise<{ file: string; change: string } | null> {
  const cur = await read($, tasks)
  if (cur) return { file: cur.file, change: cur.change }
  const p = await read($, phase)
  if (p.change) return { file: tasksPathOf(await $.session.root(), p.change), change: p.change }
  try {
    const dir = `${await $.session.root()}/openspec/changes`
    const names = (await $.fs.list(dir)).filter((e: any) => e.kind === 'dir' && e.name !== 'archive').map((e: any) => String(e.name))
    if (names.length === 1 && names[0]) return { file: `${dir}/${names[0]}/tasks.md`, change: names[0] }
  } catch {}
  return null
}

// ── Sub agents ─────────────────────────────────────────────────────────────

async function patchAgent($: any, id: string, fn: (a: AgentRow) => AgentRow): Promise<AgentRow | null> {
  let out: AgentRow | null = null
  await update($, agents, map => {
    const a = map[id]
    if (!a) return map
    out = fn(a)
    return { ...map, [id]: out }
  })
  return out
}

async function refreshWaiting($: any): Promise<void> {
  const map = await read($, agents)
  const live = Object.values(map).filter(a => a.status === 'running' || a.status === 'waiting')
  if (!live.length) return
  let list: any[]
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const byId = new Map(list.map((a: any) => [a.id, a.status]))
  for (const a of live) {
    const s = byId.get(a.id)
    if (s === undefined) continue
    const nextStatus = s === 'waiting' || s === 'idle' ? 'waiting' : s === 'running' || s === 'pending' ? 'running' : null
    if (nextStatus && nextStatus !== a.status) await patchAgent($, a.id, x => ({ ...x, status: nextStatus }))
  }
}

// ── Pane ───────────────────────────────────────────────────────────────────

async function openPane($: any, { asked }: { asked: boolean }): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'opsx-board' })
  const placed = opened?.isPlaced !== false
  if (placed || asked) await update($, isPaneOpen, () => true)
  return placed
}

async function onTick($: any): Promise<void> {
  if (await read($, isPaused)) return
  ticks += 1
  const open = await read($, isPaneOpen)
  if (!(await read($, isDemo)) && ticks % LIST_TICKS === 0) await refreshWaiting($).catch(() => {})
  if (!open && ticks % IDLE_REDRAW_TICKS !== 0) return
  if (open || hasSomething(await read($, phase), await read($, tasks), await read($, agents))) {
    const now = await $.clock.now()
    await update($, tickAt, () => now)
  }
}

// ── Hooks ──────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Record<string, unknown>
  strict = o.strict === true
  inject = o.inject_instructions !== false
  autoOpen = o.auto_open !== false
  langOption = o.language

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    lang = resolveLang(langOption, {
      LC_ALL: await $.env.get('LC_ALL'),
      LC_MESSAGES: await $.env.get('LC_MESSAGES'),
      LANG: await $.env.get('LANG'),
    })
    await update($, langState, () => lang)
    await $.command.register({
      name: 'opsx-board',
      description: t(lang, 'cmd.description'),
      argumentHint: '[clear|off|demo]',
    })
    await $.tool.register({
      name: 'task',
      description: toolDescription(lang),
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: t(lang, 'tool.arg.taskId') },
          status: { type: 'string', enum: ['start', 'done'], description: t(lang, 'tool.arg.status') },
          note: { type: 'string', description: t(lang, 'tool.arg.note') },
        },
        required: ['task_id', 'status'],
      },
    })
    await refreshStatus($)
    if (e.isInteractive) {
      $.clock.every(TICK_MS, () => {
        void onTick($).catch(() => {})
      })
    }
    return out
  })

  on('command.run', { command: 'opsx-board' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (arg === 'off') {
      await update($, isPaused, () => true)
      $.ui.status(undefined)
      if (await read($, isPaneOpen)) await $.ui.close({ id: PANE }).catch(() => {})
      return { text: t(lang, 'cmd.off') }
    }
    if (arg === 'clear') {
      await update($, agents, map => Object.fromEntries(Object.entries(map).filter(([, a]) => a.status === 'running' || a.status === 'waiting')))
      await touch($)
      return { text: t(lang, 'cmd.cleared') }
    }
    if (arg === 'demo') {
      const next = !(await read($, isDemo))
      await update($, isDemo, () => next)
      await update($, isPaused, () => false)
      if (next && !(await read($, isPaneOpen))) await openPane($, { asked: true })
      await touch($)
      return { text: t(lang, next ? 'cmd.demoOn' : 'cmd.demoOff') }
    }
    if (arg !== '') return { text: t(lang, 'cmd.usage') }
    if (await read($, isPaused)) {
      await update($, isPaused, () => false)
      await refreshStatus($)
    }
    if (await read($, isPaneOpen)) {
      await $.ui.close({ id: PANE }).catch(() => {})
      await update($, isPaneOpen, () => false)
      return { text: t(lang, 'cmd.closed') }
    }
    const placed = await openPane($, { asked: true })
    return { text: t(lang, placed ? 'cmd.opened' : 'cmd.openedNarrow') }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isPaneOpen, () => false)
    return next(e)
  })

  // ── Phase: /opsx:<kind>, openspec-<kind> skill, the Skill tool ────────────

  on('command.run', { command: /^opsx[:/]/ }, async ($, e, next) => {
    const found = phaseFromCommand(e.command, e.args)
    if (found) await setPhase($, found.kind, found.change)
    return next(e)
  })

  on('skill.prompt', { skill: /^openspec-/ }, async ($, e, next) => {
    const kind = phaseFromSkill(e.skill)
    if (kind) await setPhase($, kind, null)
    const out = await next(e)
    if (inject && e.skill === 'openspec-apply-change') return { text: `${out.text}\n\n${applyRule(lang)}` }
    return out
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!inject || (await read($, isPaused))) return out
    if ((await read($, phase)).kind !== 'apply') return out
    if (out.sections.some(s => s.id === 'opsx-board:apply')) return out
    return { sections: [...out.sections, { id: 'opsx-board:apply', text: applyRule(lang), scope: 'session' as const }] }
  })

  // ── The task tool ─────────────────────────────────────────────────────────

  // A RegExp matcher: the plugin's own tool is not in the built-in tool union the types declare
  on('tool.call', { tool: /^mcp__opsx-board__task$/ }, async ($, e) => {
    const input = e as unknown as { task_id?: unknown; status?: unknown; note?: unknown }
    const id = String(input.task_id ?? '').trim()
    const status = String(input.status ?? '').trim()
    if (!id || (status !== 'start' && status !== 'done')) {
      return { result: { ok: false, error: t(lang, 'tool.err.args') } }
    }
    const where = await resolveTasksFile($)
    if (!where) return { result: { ok: false, error: t(lang, 'tool.err.noTasks') } }
    let text: string
    try {
      text = await $.fs.read(where.file)
    } catch {
      return { result: { ok: false, error: t(lang, 'tool.err.read', { file: where.file }) } }
    }
    if ((await read($, phase)).kind === 'idle') await setPhase($, 'apply', where.change)
    if (status === 'start') {
      const list = await applyTasksText($, where.file, where.change, text, false)
      const item = list.items.find(i => i.id === id)
      if (!item) return { result: { ok: false, error: t(lang, 'tool.err.unknown', { id }), known: list.items.filter(i => !i.done).map(i => i.id) } }
      await update($, tasks, cur => (cur ? { ...cur, current: id } : cur))
      await refreshStatus($)
      const p = progressOf(list.items)
      return { result: { ok: true, task: `${item.id} ${item.title}`, progress: `${p.done}/${p.total}` } }
    }
    const marked = markDone(text, id)
    if (!marked.found) {
      const list = await applyTasksText($, where.file, where.change, text)
      return { result: { ok: false, error: t(lang, 'tool.err.unknown', { id }), known: list.items.filter(i => !i.done).map(i => i.id) } }
    }
    if (marked.changed) await $.fs.write(where.file, marked.text)
    const list = await applyTasksText($, where.file, where.change, marked.text, false)
    const p = progressOf(list.items)
    const nextItem = list.items.find(i => !i.done) ?? null
    const done = list.items.find(i => i.id === id)
    toast($, t(lang, 'toast.taskDone', { id, title: truncate(done?.title ?? '', 30), progress: `${p.done}/${p.total}` }))
    return {
      result: {
        ok: true,
        marked: marked.changed,
        progress: `${p.done}/${p.total}`,
        next: nextItem ? `${nextItem.id} ${nextItem.title}` : null,
        all_done: p.done === p.total,
      },
    }
  })

  // ── Other tool calls: phase from paths / Bash, tasks.md tracking, agent counters ──

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const anyE = e as unknown as Record<string, unknown>
    const path = typeof anyE.file_path === 'string' ? anyE.file_path : null

    // A sub agent's tool call: count it and note the last action
    if (e.agentId) {
      const a = (await read($, agents))[e.agentId]
      if (a) await patchAgent($, e.agentId, x => ({ ...x, tools: x.tools + 1, lastTool: detailOf(tool, e) }))
    }

    if (tool === 'Skill') {
      const kind = phaseFromSkill(String(anyE.skill ?? ''))
      if (kind) await setPhase($, kind, null)
      return next(e)
    }

    if (tool === 'Bash' && typeof anyE.command === 'string') {
      const found = parseOpenspecBash(anyE.command)
      if (found) {
        if (found.sub === 'archive') {
          const ran = await next(e)
          if (ran.deny === undefined && ran.isError !== true) await clearPhase($)
          return ran
        }
        if (found.sub === 'new change') await setPhase($, 'propose', found.change)
        else if (found.change) await setPhase($, null, found.change)
      }
      return next(e)
    }

    if (path && changeFromPath(path)) {
      const change = changeFromPath(path) as string
      if (!isTasksFile(path)) {
        await setPhase($, null, change)
        return next(e)
      }
      // tasks.md
      if (tool === 'Read') {
        const ran = await next(e)
        try {
          await applyTasksText($, path, change, await $.fs.read(path))
        } catch {}
        return ran
      }
      if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
        let before = ''
        try {
          before = await $.fs.read(path)
        } catch {}
        const prevItems = parseTasks(before).items
        let predicted = 0
        const sim = simulateEdit(before, anyE as any)
        if (sim !== null) predicted = flippedDone(prevItems, parseTasks(sim).items)
        if (strict && predicted > 1) return { deny: strictDenyText(lang, predicted) }
        const ran = await next(e)
        if (ran.deny !== undefined || ran.isError === true) return ran
        let after = sim ?? before
        try {
          after = await $.fs.read(path)
        } catch {}
        // Ticking checkboxes in tasks.md means apply; with no phase known yet, assume it
        await setPhase($, (await read($, phase)).kind === 'idle' ? 'apply' : null, change)
        const list = await applyTasksText($, path, change, after)
        const flipped = flippedDone(prevItems, list.items)
        if (flipped > 1) return { ...ran, context: [...(ran.context ?? []), nudgeText(lang, flipped)] }
        return ran
      }
    }
    return next(e)
  })

  // ── Sub agents ───────────────────────────────────────────────────────────

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || !r.agentId) return r
    const now = await $.clock.now()
    const row = newAgent({
      id: r.agentId,
      description: e.description,
      type: e.subagentType,
      model: r.model,
      parentId: e.parentAgentId,
      background: e.background,
      now,
    })
    await update($, agents, map => pruneAgents({ ...map, [row.id]: row }))
    await update($, updatedAt, () => now)
    if (!(await read($, isPaused))) toast($, spawnToast(lang, row))
    if (autoOpen && !autoOpened && !(await read($, isPaused))) {
      autoOpened = true
      void openPane($, { asked: false }).catch(() => {})
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const known = id !== undefined && (await read($, agents))[id] !== undefined
    if (known && id) {
      await patchAgent($, id, a => ({
        ...a,
        effort: a.effort ?? (e.effort === undefined ? null : String(e.effort)),
        model: a.model || e.model,
      }))
    }
    const r = yield* next(e)
    if (known && id) {
      const first = r.toolUses[0]
      await patchAgent($, id, a => {
        const withUsage = addUsage(a, r.usage)
        return {
          ...withUsage,
          steps: a.steps + 1,
          model: r.usage?.model ?? a.model,
          lastTool: first ? detailOf(first.name, first.input) : a.lastTool,
        }
      })
      const now = await $.clock.now()
      await update($, updatedAt, () => now)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) return next(e)
    const a = (await read($, agents))[id]
    if (!a) return next(e)
    const now = await $.clock.now()
    const status = statusFromReason(e.reason)
    const reason = e.reason === 'refusal' ? `refusal${e.refusal.category ? ` (${e.refusal.category})` : ''}` : e.reason
    const row = await patchAgent($, id, x => {
      const withUsage = x.steps === 0 ? addUsage(x, e.usage) : x
      return { ...withUsage, status, endedAt: now, failReason: status === 'completed' ? null : reason }
    })
    await update($, updatedAt, () => now)
    if (row && !(await read($, isPaused))) toast($, endToast(lang, row))
    return next(e)
  })

  // ── Drawing ──────────────────────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((await read($, isPaused)) || e.props.hasSurvey) return next(e)
    await read($, tickAt)
    const L = await read($, langState)
    const demo = await read($, isDemo)
    const now = demo ? DEMO_NOW : await $.clock.now()
    const text = demo
      ? bandText(L, DEMO_PHASE, DEMO_TASKS, DEMO_AGENTS, DEMO_NOW - 3000, now)
      : bandText(L, await read($, phase), await read($, tasks), await read($, agents), await read($, updatedAt), now)
    if (text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // AbovePrompt is a chain: draw our line, then whatever the plugins beneath drew
    const below = await next(e)
    // A thin rule between our line and the band of the plugin beneath; none when the engine drew nothing of its own
    const hasBelow = below !== null && below !== undefined && (below as { type?: string }).type !== 'engine'
    const rule = hasBelow ? <Text key="rule" dimColor>{'─'.repeat(Math.max(8, Math.min(e.props.bodyColumns ?? 60, 200)))}</Text> : null
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end" dimColor>
          {text}
        </Text>
        {rule}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'opsx-board' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tickAt)
    const L = await read($, langState)
    const demo = await read($, isDemo)
    const now = demo ? DEMO_NOW : await $.clock.now()
    const rows: PaneRow[] = demo
      ? paneModel(L, DEMO_PHASE, DEMO_TASKS, DEMO_AGENTS, now)
      : paneModel(L, await read($, phase), await read($, tasks), await read($, agents), now)
    const okAt = demo ? DEMO_NOW - 2000 : await read($, updatedAt)
    const list = demo ? DEMO_TASKS : await read($, tasks)
    const cur = currentTask(list)
    const isDeclared = cur !== null && list !== null && list.current === cur.id
    return (
      <Box flexDirection="column">
        {demo && (
          <Text key="demo" color="cyan">
            {t(L, 'pane.demo')}
          </Text>
        )}
        {rows.map((row, i) =>
          row.rule ? (
            <Text key={`r${i}`} dimColor>
              {'─'.repeat(Math.max(8, Math.min(e.props.bodyColumns ?? 40, 200)))}
            </Text>
          ) : (
            <Text
              key={`r${i}`}
              wrap="truncate-end"
              bold={row.tone === 'bold' || undefined}
              dimColor={row.tone === 'dim' || undefined}
              color={row.tone === 'warn' ? 'yellow' : row.tone === 'ok' ? 'green' : undefined}
            >
              {row.text}
            </Text>
          ),
        )}
        <Text key="footer" dimColor wrap="truncate-end">
          {okAt > 0 ? t(L, 'pane.updated', { s: Math.max(0, Math.round((now - okAt) / 1000)) }) : t(L, 'pane.noEvents')}
          {cur ? t(L, isDeclared ? 'pane.currentDeclared' : 'pane.currentInferred') : ''}
        </Text>
        <Box>
          <Button
            key="clear"
            label={t(L, 'pane.clear')}
            onPress={() =>
              void update($, agents, map => Object.fromEntries(Object.entries(map).filter(([, a]) => a.status === 'running' || a.status === 'waiting'))).catch(() => {})
            }
          />
          <Button key="close" label={t(L, 'pane.close')} role="dismiss" onPress={() => void $.ui.close({ id: PANE }).catch(() => {})} />
        </Box>
      </Box>
    )
  })
}
