// opsx-board data types and the $.state contract.
// Three parts: the OpenSpec phase, the task list of tasks.md, and this session's sub agents.

/** OpenSpec phase: `idle` means no opsx flow is running; otherwise from /opsx:<kind> or an openspec-<kind> skill */
export type Phase = {
  kind: string
  /** The change name (openspec/changes/<change>/); null while unknown */
  change: string | null
  /** When this phase was entered */
  since: number
}

export type TaskItem = {
  /** The number, e.g. 1.2 */
  id: string
  title: string
  done: boolean
  /** Line in tasks.md (0-based) */
  line: number
  /** The enclosing ## section title; empty when there is none */
  section: string
}

export type TaskSection = { title: string; line: number }

export type Tasks = {
  /** Absolute path of tasks.md */
  file: string
  change: string
  items: TaskItem[]
  sections: TaskSection[]
  /** The task the model declared as current through the task tool; null = infer the first undone one */
  current: string | null
  updatedAt: number
}

export type AgentStatusKind = 'running' | 'waiting' | 'completed' | 'failed' | 'killed'

export type AgentRow = {
  id: string
  /** The Agent tool's description (a few words naming the task) */
  description: string
  /** Agent type: Explore, general-purpose, a plugin's agent, … */
  type: string
  /** Resolved model id */
  model: string
  /** Effort of the first turn.step; null until seen */
  effort: string | null
  status: AgentStatusKind
  startedAt: number
  endedAt: number | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Model requests (turn.step) */
  steps: number
  /** Tool calls */
  tools: number
  /** Summary of the last tool call, e.g. `Grep "refreshToken"` */
  lastTool: string
  parentId: string | null
  background: boolean
  /** Why it failed or was stopped */
  failReason: string | null
}

/** UI language, as hooks/i18n.ts resolves it */
export type UiLang = 'en' | 'zh-TW' | 'ja'

declare module 'claude-code' {
  interface PluginState {
    'opsx-board': {
      phase: Phase
      tasks: Tasks | null
      /** agentId → one row */
      agents: Record<string, AgentRow>
      isPaneOpen: boolean
      /** True after /opsx-board off: band, pane and status line are hidden */
      isPaused: boolean
      /** Demo mode: draw fake data */
      isDemo: boolean
      /** Last time the state changed (the band's "N s ago") */
      updatedAt: number
      /** Written on every timer tick, only so "running N s" redraws */
      tickAt: number
      /** The resolved UI language */
      lang: UiLang
    }
  }
}
