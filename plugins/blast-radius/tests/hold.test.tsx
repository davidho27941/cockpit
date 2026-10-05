// blast-radius hold tests: `claude plugin test plugins/blast-radius`
//
// Regression coverage for the hold itself: a risky command is held, the pane
// is drawn with its buttons, Cancel refuses the call and Proceed runs it.
// The 2026-10-05 fix (draw()'s first parameter shadowed the translation
// function, so every pane came out empty) is what these tests pin down.
//
// The risky command line is assembled from pieces so that a Bash command which
// writes or greps this file is not itself held by the mod.

import { describe, expect, mock, test } from 'claude-code/testing'

const ROOT = '/home/u/proj'
const RM_RF = ['rm', '-rf'].join(' ')

type World = {
  clock: ReturnType<typeof mock.clock>
  ran: string[]
  toasts: string[]
  opened: { id: string; focus?: boolean }[]
  closed: string[]
  isPlaced: boolean
}

function world(on: any, options: Partial<Pick<World, 'isPlaced'>> = {}, env: Record<string, string> = { LANG: 'en_US.UTF-8' }): World {
  const w: World = { clock: mock.clock(on, { now: 1_000_000 }), ran: [], toasts: [], opened: [], closed: [], isPlaced: true, ...options }
  mock.env(on, env)
  const value = (v: unknown) => ({ value: v })
  const ok = (stdout: string, exitCode = 0, stderr = '') => value({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  on('session.cwd', () => value(ROOT))
  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'sleep') {
      await w.clock.sleep(250)
      return ok('')
    }
    // The rm measuring script: "<files> <bytes> <paths found>" then the first files
    if (argv[0] === 'bash') return ok('3 6144 1\n./build/a.js\n./build/b.js\n./build/c.js\n')
    return ok('')
  })
  on('ui.open', (_$: any, e: any) => {
    w.opened.push({ id: e.id, focus: e.focus })
    return value({ isPlaced: w.isPlaced })
  })
  on('ui.close', (_$: any, e: any) => {
    w.closed.push(e.id)
    return value(undefined)
  })
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e))
    return value(undefined)
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  // The Bash tool itself: records what actually ran
  on('tool.call', (_$: any, e: any) => {
    w.ran.push(String(e.command))
    return { result: { stdout: 'ran', stderr: '', interrupted: false }, text: 'ran' }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  return w
}

async function start($: any, w: World): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

const PANE = { plugin: 'blast-radius', component: 'Pane', requestId: 'blast-radius', props: {} } as const
const BAND = { plugin: 'blast-radius', component: 'AbovePrompt', props: {} } as const

function bash($: any, command: string): Promise<any> {
  return $.tool.call({ tool: 'Bash', tool_use_id: `t-${Math.random().toString(36).slice(2)}`, command })
}

async function textsOf(ui: any): Promise<string[]> {
  const found = await ui.findAll({ type: 'Text' })
  return found.map((x: any) => String(x.text ?? ''))
}

const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l))

describe('hold', () => {
  test('a risky command is held and the pane draws the report with its buttons', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, `${RM_RF} build`)
    await w.clock.settle()
    expect(w.opened).toEqual([{ id: 'blast-radius', focus: true }])
    expect(w.ran).toEqual([])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const lines = await textsOf(ui)
    expect(has(lines, /Blast Radius · rm -rf/)).toBe(true)
    expect(has(lines, /delete 3 files/)).toBe(true)
    expect(has(lines, /build\/a\.js/)).toBe(true)
    expect(await ui.find({ key: 'proceed' })).toBeDefined()
    expect(await ui.find({ key: 'cancel' })).toBeDefined()
    expect(has(lines, /waiting on your answer/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await w.clock.advance(300)
    const r = await call
    expect(r.deny).toMatch(/pressed Cancel/)
    expect(r.deny).toMatch(/do not retry unless asked/)
    expect(w.ran).toEqual([])
    expect(w.closed).toEqual(['blast-radius'])
  })

  test('Proceed runs the command as written and toasts', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, `${RM_RF} build`)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    await ui.press({ key: 'proceed' })
    await w.clock.advance(300)
    const r = await call
    expect(r.deny).toBeUndefined()
    expect(w.ran).toEqual([`${RM_RF} build`])
    expect(w.toasts.some(t => /running it/.test(t))).toBe(true)
  })

  test('without room for a pane the report is drawn in the band', async ($, on) => {
    const w = world(on, { isPlaced: false })
    await start($, w)
    const call = bash($, `${RM_RF} build`)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    const lines = await textsOf(band)
    expect(has(lines, /delete 3 files/)).toBe(true)
    expect(await band.find({ key: 'cancel' })).toBeDefined()
    await band.press({ key: 'cancel' })
    await w.clock.advance(300)
    expect((await call).deny).toMatch(/pressed Cancel/)
  })

  test('the pane is drawn in the chosen language', async ($, on) => {
    const w = world(on, {}, { LANG: 'ja_JP.UTF-8' })
    await start($, w)
    const call = bash($, `${RM_RF} build`)
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const lines = await textsOf(ui)
    expect(has(lines, /Claude はあなたの回答を待っています/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await w.clock.advance(300)
    expect((await call).deny).toMatch(/do not retry unless asked/)
  })

  test('an ordinary command passes straight through', async ($, on) => {
    const w = world(on)
    await start($, w)
    const r = await bash($, 'ls -la')
    expect(r.deny).toBeUndefined()
    expect(w.ran).toEqual(['ls -la'])
    expect(w.opened).toEqual([])
  })
})
