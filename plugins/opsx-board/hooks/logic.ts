// opsx-board pure functions: tasks.md parsing and rewriting, phase detection, agent
// bookkeeping, band / pane layout, toast text. No `$` here; shared with register.tsx
// and the tests. Every function that produces text takes the UI language.

import type { AgentRow, AgentStatusKind, Phase, TaskItem, TaskSection, Tasks } from '../types'
import { t } from './i18n'
import type { Lang } from './i18n'

export type { AgentRow, AgentStatusKind, Phase, TaskItem, TaskSection, Tasks }

export const PLUGIN = 'opsx-board'
export const PANE = 'opsx-board'
export const TOOL = 'mcp__opsx-board__task'
export const TICK_MS = 1000
/** Redraw every N ticks while the pane is closed */
export const IDLE_REDRAW_TICKS = 5
/** Ask $.agent.list() every N ticks to refresh the "waiting" group */
export const LIST_TICKS = 5
export const TOAST_MS = 6000
export const MAX_AGENTS = 50
export const NEXT_TASKS = 3

export const IDLE_PHASE: Phase = { kind: 'idle', change: null, since: 0 }

// ── Text helpers ───────────────────────────────────────────────────────────

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`
}

/** Token count: raw under 1000, then 12.4k / 12k / 1.2M */
export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.max(0, Math.round(n))}`
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${String(s % 60).padStart(2, '0')}s` : ''}`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Shortens a model id to its family: claude-sonnet-5-5 → sonnet; unknown ids pass through */
export function shortModel(model: string): string {
  const m = /^(?:[a-z]+\.)?(?:anthropic\.)?claude-(fable|opus|sonnet|haiku)\b/i.exec(model)
  if (m && m[1]) return m[1].toLowerCase()
  const alias = /^(fable|opus|sonnet|haiku)$/i.exec(model.trim())
  return alias && alias[1] ? alias[1].toLowerCase() : model
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** One-line summary of a tool call: Read logic.ts, Bash npm test, Grep "refreshToken" */
export function detailOf(tool: string, input: unknown): string {
  const name = tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const raw = o.file_path ?? o.pattern ?? o.command ?? o.query ?? o.url ?? o.description ?? o.skill ?? o.task_id ?? ''
  let s = String(raw).replace(/\s+/g, ' ').trim()
  if (typeof o.file_path === 'string') s = baseName(s)
  if (typeof o.pattern === 'string' || typeof o.query === 'string') s = `"${s}"`
  return s ? `${name} ${truncate(s, 32)}` : name
}

// ── Phase detection ────────────────────────────────────────────────────────

const SKILL_PHASE: Record<string, string> = {
  'openspec-explore': 'explore',
  'openspec-propose': 'propose',
  'openspec-apply-change': 'apply',
  'openspec-archive-change': 'archive',
  'openspec-sync-specs': 'sync',
  'openspec-continue-change': 'propose',
  'openspec-new-change': 'propose',
  'openspec-verify-change': 'verify',
}

/** openspec-<x> skill name → phase; null for a skill that is not OpenSpec's */
export function phaseFromSkill(skill: string): string | null {
  if (SKILL_PHASE[skill]) return SKILL_PHASE[skill] as string
  if (skill.startsWith('openspec-')) return skill.slice('openspec-'.length).replace(/-change$/, '')
  return null
}

/** /opsx:<kind> [change] → phase and change name; null for any other command */
export function phaseFromCommand(command: string, args: string): { kind: string; change: string | null } | null {
  const m = /^opsx[:/]([a-z0-9-]+)$/i.exec(command.trim())
  if (!m || !m[1]) return null
  const first = args.trim().split(/\s+/)[0] ?? ''
  const change = first && !first.startsWith('-') && isChangeName(first) ? first : null
  return { kind: m[1].toLowerCase(), change }
}

const CHANGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/

export function isChangeName(s: string): boolean {
  return CHANGE_RE.test(s) && s !== 'archive'
}

/** The <change> in a path under openspec/changes/<change>/… (archive/ does not count) */
export function changeFromPath(path: string): string | null {
  const m = /(?:^|\/)openspec\/changes\/([^/]+)\//.exec(path)
  if (!m || !m[1] || m[1] === 'archive') return null
  return m[1]
}

export function isTasksFile(path: string): boolean {
  return /(?:^|\/)openspec\/changes\/(?!archive\/)[^/]+\/tasks\.md$/.test(path)
}

export function tasksPathOf(root: string, change: string): string {
  return `${root.replace(/\/+$/, '')}/openspec/changes/${change}/tasks.md`
}

/** An `openspec` command in a Bash line: its subcommand and the --change (or positional) name */
export function parseOpenspecBash(command: string): { sub: string; change: string | null } | null {
  const m = /(?:^|[;&|]\s*|\n\s*)openspec\s+(status|instructions|new\s+change|archive|validate|show|list|change)\b([^\n;&|]*)/.exec(command)
  if (!m || !m[1]) return null
  const sub = m[1].replace(/\s+/g, ' ')
  const rest = m[2] ?? ''
  let change: string | null = null
  const flag = /--change\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(rest)
  if (flag) change = flag[1] ?? flag[2] ?? flag[3] ?? null
  else {
    const pos = rest
      .trim()
      .split(/\s+/)
      .filter(tok => tok && !tok.startsWith('-'))
    const cand = sub === 'instructions' ? pos[1] : pos[0]
    if (cand && isChangeName(cand)) change = cand
  }
  if (change !== null && !isChangeName(change)) change = null
  return { sub, change }
}

// ── tasks.md ───────────────────────────────────────────────────────────────

const ITEM_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(\d+(?:\.\d+)*)\.?\s+(.*)$/
const SECTION_RE = /^\s*#{2,3}\s+(.*?)\s*$/

export function parseTasks(text: string): { items: TaskItem[]; sections: TaskSection[] } {
  const items: TaskItem[] = []
  const sections: TaskSection[] = []
  let section = ''
  text.split('\n').forEach((raw, line) => {
    const h = SECTION_RE.exec(raw)
    if (h && h[1] !== undefined) {
      section = h[1]
      sections.push({ title: section, line })
      return
    }
    const m = ITEM_RE.exec(raw)
    if (!m || m[2] === undefined) return
    items.push({ id: m[2], title: (m[3] ?? '').trim(), done: m[1] !== ' ', line, section })
  })
  return { items, sections }
}

export function progressOf(items: readonly TaskItem[]): { done: number; total: number } {
  return { done: items.filter(i => i.done).length, total: items.length }
}

/** The current task: the one the model declared, else the first undone one; null when all are done */
export function currentTask(tasks: Tasks | null): TaskItem | null {
  if (!tasks) return null
  if (tasks.current !== null) {
    const declared = tasks.items.find(i => i.id === tasks.current)
    if (declared && !declared.done) return declared
  }
  return tasks.items.find(i => !i.done) ?? null
}

/** Up to n undone tasks after the current one */
export function nextTasks(tasks: Tasks | null, n = NEXT_TASKS): TaskItem[] {
  const cur = currentTask(tasks)
  if (!tasks || !cur) return []
  return tasks.items.filter(i => !i.done && i.id !== cur.id).slice(0, n)
}

/** Rewrites the `- [ ] <id>` line to `- [x]`; `changed` is false when not found or already done */
export function markDone(text: string, id: string): { text: string; changed: boolean; found: boolean } {
  const lines = text.split('\n')
  let found = false
  let changed = false
  const out = lines.map(raw => {
    const m = ITEM_RE.exec(raw)
    if (!m || m[2] !== id) return raw
    found = true
    if (m[1] !== ' ') return raw
    changed = true
    return raw.replace(/\[ \]/, '[x]')
  })
  return { text: changed ? out.join('\n') : text, changed, found }
}

/** How many tasks this edit flipped from undone to done */
export function flippedDone(prev: readonly TaskItem[], next: readonly TaskItem[]): number {
  const before = new Map(prev.map(i => [i.id, i.done]))
  return next.filter(i => i.done && before.get(i.id) === false).length
}

/** Simulates the file after an Edit / Write (for the strict check; the real content is re-read afterwards) */
export function simulateEdit(
  text: string,
  e: { tool: string; old_string?: unknown; new_string?: unknown; replace_all?: unknown; content?: unknown },
): string | null {
  if (e.tool === 'Write') return typeof e.content === 'string' ? e.content : null
  if (e.tool !== 'Edit' || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null
  if (!e.old_string) return null
  return e.replace_all === true ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string as string)
}

// ── Agents ─────────────────────────────────────────────────────────────────

export type AgentGroup = 'running' | 'waiting' | 'done'
const GROUP_ORDER: readonly AgentGroup[] = ['running', 'waiting', 'done']
/** Icon in front of each group header in the pane */
export const GROUP_ICON: Record<AgentGroup, string> = { running: '●', waiting: '◐', done: '○' }

export function groupLabel(lang: Lang, g: AgentGroup): string {
  return t(lang, g === 'running' ? 'group.running' : g === 'waiting' ? 'group.waiting' : 'group.done')
}

export function groupOf(a: AgentRow): AgentGroup {
  if (a.status === 'running') return 'running'
  if (a.status === 'waiting') return 'waiting'
  return 'done'
}

export function tokensOf(a: AgentRow): number {
  return a.input + a.output + a.cacheRead + a.cacheWrite
}

export function agentSymbol(a: AgentRow): string {
  switch (a.status) {
    case 'running':
      return '▶'
    case 'waiting':
      return '⏸'
    case 'completed':
      return '✓'
    case 'killed':
      return '■'
    default:
      return '✗'
  }
}

export function statusFromReason(reason: string): AgentStatusKind {
  if (reason === 'answer') return 'completed'
  if (reason === 'aborted') return 'killed'
  return 'failed'
}

/** Over the cap, drop the earliest finished agents first */
export function pruneAgents(agents: Readonly<Record<string, AgentRow>>, max = MAX_AGENTS): Record<string, AgentRow> {
  const rows = Object.values(agents)
  if (rows.length <= max) return { ...agents }
  const finished = rows.filter(a => groupOf(a) === 'done').sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const drop = new Set(finished.slice(0, rows.length - max).map(a => a.id))
  const out: Record<string, AgentRow> = {}
  for (const a of rows) if (!drop.has(a.id)) out[a.id] = a
  return out
}

export function sortedAgents(agents: Readonly<Record<string, AgentRow>>): AgentRow[] {
  return Object.values(agents).sort((a, b) => a.startedAt - b.startedAt)
}

export function agentLine(lang: Lang, a: AgentRow, now: number): string {
  const model = `${shortModel(a.model)}${a.effort ? `/${a.effort}` : ''}`
  const tail =
    a.status === 'running'
      ? t(lang, 'agent.ranFor', { d: duration(now - a.startedAt) })
      : a.status === 'waiting'
        ? t(lang, 'agent.waitedFor', { d: duration(now - a.startedAt) })
        : a.status === 'failed'
          ? t(lang, 'agent.failed', { reason: truncate(a.failReason ?? 'error', 40) })
          : a.status === 'killed'
            ? t(lang, 'agent.killed', { d: duration((a.endedAt ?? now) - a.startedAt) })
            : duration((a.endedAt ?? now) - a.startedAt)
  return [`${agentSymbol(a)} ${truncate(a.description || a.type, 40)}`, a.type, model, `${fmt(tokensOf(a))} tok`, tail].join(' · ')
}

export function agentDetail(lang: Lang, a: AgentRow): string {
  const parts = [t(lang, 'agent.step', { n: a.steps }), t(lang, 'agent.tools', { n: a.tools })]
  if (a.lastTool) parts.push(t(lang, 'agent.last', { tool: a.lastTool }))
  if (a.input || a.output) parts.push(`↑${fmt(a.input + a.cacheRead + a.cacheWrite)} ↓${fmt(a.output)}`)
  return parts.join(' · ')
}

export function spawnToast(lang: Lang, a: AgentRow): string {
  return t(lang, 'toast.spawn', { name: truncate(a.description || a.type, 40), type: a.type })
}

export function endToast(lang: Lang, a: AgentRow): string {
  const name = truncate(a.description || a.type, 40)
  if (a.status === 'completed') return t(lang, 'toast.done', { name, tok: fmt(tokensOf(a)), d: duration((a.endedAt ?? a.startedAt) - a.startedAt) })
  if (a.status === 'killed') return t(lang, 'toast.killed', { name })
  return t(lang, 'toast.failed', { name, reason: truncate(a.failReason ?? 'error', 60) })
}

// ── Model-facing text ──────────────────────────────────────────────────────

export function toolDescription(lang: Lang): string {
  return t(lang, 'tool.description')
}

export function applyRule(lang: Lang): string {
  return t(lang, 'rule.apply')
}

export function nudgeText(lang: Lang, n: number): string {
  return t(lang, 'rule.nudge', { n })
}

export function strictDenyText(lang: Lang, n: number): string {
  return t(lang, 'rule.strictDeny', { n })
}

// ── Band / status line / pane ──────────────────────────────────────────────

export function phaseLabel(p: Phase): string {
  return `opsx ${p.kind}${p.change ? ` ${p.change}` : ''}`
}

/** Head of the band and status line: the phase when known, else the change name tasks.md gave us */
export function headLabel(phase: Phase, tasks: Tasks | null): string | null {
  if (phase.kind !== 'idle') return phaseLabel(phase)
  if (tasks) return `opsx ${tasks.change}`
  return null
}

export function statusText(phase: Phase, tasks: Tasks | null): string | undefined {
  const head = headLabel(phase, tasks)
  if (head === null) return undefined
  const parts = [head]
  const cur = currentTask(tasks)
  if (tasks) {
    if (cur) parts.push(cur.id)
    const p = progressOf(tasks.items)
    parts.push(`${p.done}/${p.total}`)
  }
  return parts.join(' · ')
}

export function agentSummary(lang: Lang, agents: Readonly<Record<string, AgentRow>>): string | null {
  const rows = Object.values(agents)
  if (!rows.length) return null
  const running = rows.filter(a => groupOf(a) === 'running').length
  const waiting = rows.filter(a => groupOf(a) === 'waiting').length
  const done = rows.length - running - waiting
  const parts: string[] = []
  if (running) parts.push(t(lang, 'band.running', { n: running }))
  if (waiting) parts.push(t(lang, 'band.waiting', { n: waiting }))
  if (done) parts.push(running || waiting ? t(lang, 'band.done', { n: done }) : t(lang, 'band.doneOnly', { n: done }))
  parts.push(`${fmt(rows.reduce((n, a) => n + tokensOf(a), 0))} tok`)
  return parts.join(' · ')
}

/** The one band line; null means it takes no row */
export function bandText(
  lang: Lang,
  phase: Phase,
  tasks: Tasks | null,
  agents: Readonly<Record<string, AgentRow>>,
  updatedAt: number,
  now: number,
): string | null {
  const parts: string[] = []
  const head = headLabel(phase, tasks)
  if (head !== null) {
    parts.push(`⧉ ${head}`)
    const cur = currentTask(tasks)
    if (cur) parts.push(`${cur.id} ${truncate(cur.title, 28)}`)
    if (tasks) {
      const p = progressOf(tasks.items)
      parts.push(`${p.done}/${p.total}`)
    }
  }
  const agentsText = agentSummary(lang, agents)
  if (agentsText) parts.push(agentsText)
  if (!parts.length) return null
  if (updatedAt > 0) parts.push(t(lang, 'band.ago', { d: duration(now - updatedAt) }))
  return parts.join(' · ')
}

const BAR_CELLS = 10

export function progressBar(items: readonly TaskItem[]): string {
  const { done, total } = progressOf(items)
  if (total === 0) return '0/0'
  const filled = Math.round((done / total) * BAR_CELLS)
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${done}/${total}`
}

export type PaneTone = 'plain' | 'bold' | 'dim' | 'warn' | 'ok'
/** A pane row; `rule` marks a horizontal separator drawn across the pane's width instead of `text`. */
export type PaneRow = { text: string; tone: PaneTone; rule?: true }

/** The pane's rows (without the footer and buttons, which belong to register.tsx) */
export function paneModel(lang: Lang, phase: Phase, tasks: Tasks | null, agents: Readonly<Record<string, AgentRow>>, now: number): PaneRow[] {
  const rows: PaneRow[] = []
  if (phase.kind === 'idle' && !tasks) {
    rows.push({ text: t(lang, 'pane.idle'), tone: 'dim' })
  } else {
    const change = phase.change ?? tasks?.change ?? null
    const head = `OpenSpec${phase.kind !== 'idle' ? ` · ${phase.kind}` : ''}${change ? ` · ${change}` : ''}`
    rows.push({ text: tasks ? `${head}  ${progressBar(tasks.items)}` : head, tone: 'bold' })
    if (tasks) {
      const cur = currentTask(tasks)
      if (cur) {
        rows.push({ text: `▶ ${cur.id} ${cur.title}${tasks.current === cur.id ? '' : t(lang, 'pane.inferred')}`, tone: 'plain' })
        const nexts = nextTasks(tasks)
        if (nexts.length) rows.push({ text: `  ${nexts.map(x => `○ ${x.id} ${truncate(x.title, 24)}`).join('   ')}`, tone: 'dim' })
      } else if (tasks.items.length) rows.push({ text: t(lang, 'pane.allDone'), tone: 'ok' })
      else rows.push({ text: t(lang, 'pane.noItems'), tone: 'dim' })
    } else if (phase.kind === 'apply') rows.push({ text: t(lang, 'pane.noTasksYet'), tone: 'dim' })
  }

  const list = sortedAgents(agents)
  const total = list.reduce((n, a) => n + tokensOf(a), 0)
  rows.push({ text: '', tone: 'dim', rule: true })
  rows.push({ text: list.length ? t(lang, 'pane.agentsHead', { n: list.length, tok: fmt(total) }) : t(lang, 'pane.noAgents'), tone: 'bold' })
  for (const g of GROUP_ORDER) {
    const inGroup = list.filter(a => groupOf(a) === g)
    if (!inGroup.length && g !== 'running') continue
    // Group header with an icon; the agents of the group are indented beneath it
    rows.push({ text: `${GROUP_ICON[g]} ${t(lang, 'pane.group', { label: groupLabel(lang, g), n: inGroup.length })}`, tone: 'bold' })
    for (const a of inGroup) {
      const tone: PaneTone = a.status === 'failed' ? 'warn' : g === 'done' ? 'dim' : 'plain'
      rows.push({ text: `  ${agentLine(lang, a, now)}`, tone })
      if (g !== 'done') rows.push({ text: `      ${agentDetail(lang, a)}`, tone: 'dim' })
    }
  }
  return rows
}

/** Whether a redraw is worth it while the pane is closed */
export function hasSomething(phase: Phase, tasks: Tasks | null, agents: Readonly<Record<string, AgentRow>>): boolean {
  return phase.kind !== 'idle' || tasks !== null || Object.keys(agents).length > 0
}

export function newAgent(input: {
  id: string
  description: string
  type: string
  model: string
  parentId?: string
  background: boolean
  now: number
}): AgentRow {
  return {
    id: input.id,
    description: input.description,
    type: input.type,
    model: input.model,
    effort: null,
    status: 'running',
    startedAt: input.now,
    endedAt: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    steps: 0,
    tools: 0,
    lastTool: '',
    parentId: input.parentId ?? null,
    background: input.background,
    failReason: null,
  }
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function addUsage(a: AgentRow, u: Usage | null | undefined): AgentRow {
  if (!u) return a
  return {
    ...a,
    input: a.input + (u.input_tokens || 0),
    output: a.output + (u.output_tokens || 0),
    cacheRead: a.cacheRead + (u.cache_read_input_tokens || 0),
    cacheWrite: a.cacheWrite + (u.cache_creation_input_tokens || 0),
  }
}
