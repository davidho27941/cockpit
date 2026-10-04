// Demo-mode fake data: a way to see the board before there is an OpenSpec project or a sub agent.
// Reads nothing, writes nothing. Task titles and agent descriptions are English and language-neutral;
// the labels around them are localized through the UI language.

import type { AgentRow, Phase, Tasks } from '../types'

export const DEMO_NOW = Date.UTC(2026, 9, 4, 1, 0, 0)

export const DEMO_PHASE: Phase = { kind: 'apply', change: 'add-auth', since: DEMO_NOW - 15 * 60000 }

const item = (id: string, title: string, done: boolean, line: number, section: string) => ({ id, title, done, line, section })

export const DEMO_TASKS: Tasks = {
  file: '/home/demo/proj/openspec/changes/add-auth/tasks.md',
  change: 'add-auth',
  sections: [
    { title: '1. Schema', line: 2 },
    { title: '2. API', line: 6 },
    { title: '3. Token', line: 10 },
  ],
  items: [
    item('1.1', 'Add users and sessions tables', true, 3, '1. Schema'),
    item('1.2', 'Add migration and rollback', true, 4, '1. Schema'),
    item('2.1', 'Implement /login and /logout', true, 7, '2. API'),
    item('2.2', 'Implement /me and permission checks', true, 8, '2. API'),
    item('3.1', 'Issue access tokens', true, 11, '3. Token'),
    item('3.2', 'Implement token refresh', false, 12, '3. Token'),
    item('3.3', 'Refresh token rotation and revocation', false, 13, '3. Token'),
    item('3.4', 'Add unit tests', false, 14, '3. Token'),
    item('3.5', 'Docs and examples', false, 15, '3. Token'),
  ],
  current: '3.2',
  updatedAt: DEMO_NOW - 3000,
}

function agent(partial: Partial<AgentRow> & Pick<AgentRow, 'id' | 'description' | 'type' | 'model' | 'status' | 'startedAt'>): AgentRow {
  return {
    effort: null,
    endedAt: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    steps: 0,
    tools: 0,
    lastTool: '',
    parentId: null,
    background: false,
    failReason: null,
    ...partial,
  }
}

export const DEMO_AGENTS: Record<string, AgentRow> = Object.fromEntries(
  [
    agent({
      id: 'a1',
      description: 'Search auth-related code',
      type: 'Explore',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      status: 'running',
      startedAt: DEMO_NOW - 42000,
      input: 1800,
      output: 1200,
      cacheRead: 9400,
      steps: 4,
      tools: 7,
      lastTool: 'Grep "refreshToken"',
    }),
    agent({
      id: 'a2',
      description: 'Write unit tests',
      type: 'general-purpose',
      model: 'claude-opus-5-5',
      effort: 'high',
      status: 'running',
      startedAt: DEMO_NOW - 12000,
      input: 4000,
      output: 2600,
      cacheRead: 24000,
      steps: 2,
      tools: 3,
      lastTool: 'Write auth.test.ts',
    }),
    agent({
      id: 'a3',
      description: 'Check schema diff',
      type: 'Explore',
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      status: 'completed',
      startedAt: DEMO_NOW - 10 * 60000,
      endedAt: DEMO_NOW - 10 * 60000 + 72000,
      input: 900,
      output: 700,
      cacheRead: 3500,
      steps: 3,
      tools: 5,
    }),
    agent({
      id: 'a4',
      description: 'Tidy API docs',
      type: 'general-purpose',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      status: 'completed',
      startedAt: DEMO_NOW - 8 * 60000,
      endedAt: DEMO_NOW - 8 * 60000 + 160000,
      input: 3000,
      output: 4000,
      cacheRead: 15000,
      steps: 6,
      tools: 11,
    }),
    agent({
      id: 'a5',
      description: 'Run e2e',
      type: 'general-purpose',
      model: 'claude-opus-5-5',
      effort: 'high',
      status: 'failed',
      startedAt: DEMO_NOW - 5 * 60000,
      endedAt: DEMO_NOW - 5 * 60000 + 95000,
      input: 2000,
      output: 1000,
      cacheRead: 12000,
      steps: 5,
      tools: 9,
      failReason: 'error',
    }),
  ].map(a => [a.id, a]),
)
