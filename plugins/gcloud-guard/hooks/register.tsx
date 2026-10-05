// gcloud-guard: holds a gcloud / gsutil command that would create, change or delete
// cloud resources, shows what it would touch, and waits for Proceed or Cancel.
//
// - tool.call (Bash): classify the command line; when it is held, look up the account,
//   project and the targets' current state with read-only gcloud calls, open a pane
//   (or draw in the band when the terminal is too narrow) and hold the call.
// - Holding: a hook has 10 s of its own time, but time spent inside a `$` call is free,
//   so the hold loop waits on `$.process.run(["sleep", "0.25"])` until a button sets the
//   decision. One hold at a time; a second risky call waits for the first.
// - Lookups pass every value as an argv element, never as shell source. No files are
//   written, nothing is sent anywhere, no model is called.
// The hold-and-ask pattern follows Anthropic's blast-radius mod in this repo.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GcloudContext, HeldView, Report, ReportContext, Risk } from '../types'
import { DEFAULT_LANG, resolveLang, t } from './i18n'
import type { Lang } from './i18n'
import {
  CONTEXT_TICK_MS,
  HOLD_LIMIT_MS,
  MAX_LINES,
  MAX_TARGETS_DESCRIBED,
  PANE,
  POLL_SECONDS,
  buildContext,
  classify,
  configGetArgv,
  contextLine,
  contextText,
  countObjects,
  currentContextOf,
  denyText,
  describeArgv,
  emptyContext,
  gcloudConfigDir,
  getIamPolicyArgv,
  headline,
  isHeld,
  isNotFound,
  isRsyncDelete,
  keyFlagsLine,
  listObjectsArgv,
  paneRows,
  projectDescribeArgv,
  readSettings,
  servicesListArgv,
  severityLabel,
  splitKubeconfigList,
  storageUrls,
  summarizeDescribe,
  touchesContext,
  truncate,
} from './logic'
import type { ContextEnv, Settings } from './logic'

const langState = atom({ plugin: 'gcloud-guard', key: 'lang' } as const, DEFAULT_LANG)
const heldState = atom({ plugin: 'gcloud-guard', key: 'held' } as const, null)
const contextState = atom({ plugin: 'gcloud-guard', key: 'context' } as const, null)
const isBandHidden = atom({ plugin: 'gcloud-guard', key: 'isBandHidden' } as const, false)

type Decision = 'proceed' | 'cancel' | 'timeout' | 'interrupted' | 'error'

/** The hold in progress: the view the render hooks draw plus the decision the buttons set. */
type Hold = { view: HeldView; decision: Decision | null }

// Module state: a hot reload mid-hold loses it, and the old hook then refuses the command.
let settings: Settings = readSettings(undefined)
let lang: Lang = DEFAULT_LANG
let held: Hold | null = null
let holdSeq = 0
/** The mtimes of the files the context line was last read from, keyed by path; the timer re-reads when one moved. */
let watched: Record<string, number> = {}
let refreshing = false

type Run = { exitCode: number; stdout: string; stderr: string }

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

// ── The context line: read from the config files, no process ───────────────

async function contextEnv($: any): Promise<ContextEnv> {
  const env: ContextEnv = {}
  try {
    env.CLOUDSDK_CONFIG = await $.env.get('CLOUDSDK_CONFIG')
    env.HOME = await $.env.get('HOME')
    env.CLOUDSDK_CORE_PROJECT = await $.env.get('CLOUDSDK_CORE_PROJECT')
    env.CLOUDSDK_CORE_ACCOUNT = await $.env.get('CLOUDSDK_CORE_ACCOUNT')
    env.CLOUDSDK_ACTIVE_CONFIG_NAME = await $.env.get('CLOUDSDK_ACTIVE_CONFIG_NAME')
    env.CLOUDSDK_COMPUTE_ZONE = await $.env.get('CLOUDSDK_COMPUTE_ZONE')
    env.CLOUDSDK_COMPUTE_REGION = await $.env.get('CLOUDSDK_COMPUTE_REGION')
  } catch {}
  return env
}

async function kubeconfigList($: any, home: string | null): Promise<string[]> {
  let value: string | undefined
  try {
    value = await $.env.get('KUBECONFIG')
  } catch {}
  return splitKubeconfigList(value, home)
}

/** A file's text, or null when it is missing or unreadable. */
async function readText($: any, path: string): Promise<string | null> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

async function mtimeOf($: any, path: string): Promise<number> {
  try {
    const st = await $.fs.stat(path)
    return Number(st?.mtimeMs ?? 0)
  } catch {
    return 0
  }
}

/** Re-reads the gcloud and kube config files and writes the snapshot; remembers the files' mtimes for the timer. */
async function refreshContext($: any): Promise<GcloudContext | null> {
  if (refreshing) return null
  refreshing = true
  try {
    const env = await contextEnv($)
    const home = (env.HOME ?? '').trim() || null
    const configDir = gcloudConfigDir(env)
    const next: Record<string, number> = {}
    let activeConfigText: string | null = null
    let configText: string | null = null
    if (configDir) {
      const activePath = `${configDir}/active_config`
      activeConfigText = await readText($, activePath)
      next[activePath] = await mtimeOf($, activePath)
      const name = (env.CLOUDSDK_ACTIVE_CONFIG_NAME ?? '').trim() || (activeConfigText ?? '').trim() || 'default'
      const configPath = `${configDir}/configurations/config_${name}`
      configText = await readText($, configPath)
      next[configPath] = await mtimeOf($, configPath)
    }
    let kubeconfigPath: string | null = null
    let kubeconfigText: string | null = null
    for (const path of await kubeconfigList($, home)) {
      const text = await readText($, path)
      next[path] = await mtimeOf($, path)
      if (text !== null && currentContextOf(text) !== null) {
        kubeconfigPath = path
        kubeconfigText = text
        break
      }
      if (kubeconfigPath === null && text !== null) kubeconfigPath = path
    }
    watched = next
    const snapshot = buildContext({ env, configDir, activeConfigText, configText, kubeconfigPath, kubeconfigText, now: await $.clock.now() })
    const known = snapshot.project || snapshot.account || snapshot.kube
    const value = known ? snapshot : null
    await update($, contextState, () => value)
    return value
  } catch {
    return null
  } finally {
    refreshing = false
  }
}

/** The timer: re-read only when one of the watched files moved. */
async function onContextTick($: any): Promise<void> {
  if (refreshing) return
  for (const [path, mtime] of Object.entries(watched)) {
    if ((await mtimeOf($, path)) !== mtime) {
      await refreshContext($)
      return
    }
  }
  // Nothing watched yet (no config dir found at start): look again for the files
  if (!Object.keys(watched).length) await refreshContext($)
}

/** Runs a read-only lookup; never throws. `null` when the process could not start (gcloud missing). */
async function lookup($: any, argv: string[]): Promise<Run | null> {
  try {
    const r = await $.process.run(argv, { timeoutMs: settings.describeTimeoutMs })
    return { exitCode: Number(r.exitCode), stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
  } catch {
    return null
  }
}

function lastLine(s: string): string {
  return truncate(s.trim().split('\n').pop() ?? '', 80)
}

/** Account, project (and where it came from) and the active configuration. */
async function readContext($: any, risk: Risk): Promise<{ context: ReportContext; gcloudMissing: boolean; failed: boolean }> {
  const context = emptyContext(risk)
  let gcloudMissing = false
  let failed = false
  if (risk.tool === 'gsutil' && risk.flags.project && risk.flags.account) return { context, gcloudMissing, failed }
  if (!context.account) {
    const r = await lookup($, configGetArgv('account', risk.flags))
    if (r === null) gcloudMissing = true
    else if (r.exitCode === 0 && r.stdout.trim()) context.account = r.stdout.trim()
    else failed = true
  }
  if (!context.project && !gcloudMissing) {
    const r = await lookup($, configGetArgv('project', risk.flags))
    if (r === null) gcloudMissing = true
    else if (r.exitCode === 0 && r.stdout.trim()) {
      context.project = r.stdout.trim()
      context.projectSource = 'config'
    } else failed = true
  }
  if (!context.configuration && !gcloudMissing) {
    const r = await lookup($, ['gcloud', 'config', 'configurations', 'list', '--filter=is_active=true', '--format=value(name)'])
    if (r !== null && r.exitCode === 0 && r.stdout.trim()) context.configuration = r.stdout.trim().split('\n')[0] ?? null
  }
  return { context, gcloudMissing, failed }
}

function pushLine(report: Report, line: string): void {
  if (report.lines.length < MAX_LINES) report.lines.push(truncate(line, 160))
}

/** Looks up what the command would touch. Never throws: a failed lookup becomes a note. */
async function measure($: any, risk: Risk): Promise<Report> {
  const { context, gcloudMissing, failed } = await readContext($, risk)
  const report: Report = { severity: risk.severity, headline: headline(lang, risk), context, lines: [], notes: [] }
  if (gcloudMissing) {
    report.notes.push(t(lang, 'note.noGcloud'))
    return report
  }
  if (failed) report.notes.push(t(lang, 'note.contextFailed'))
  if (risk.unknownVerb) report.notes.push(t(lang, 'note.unknownVerb'))

  // A whole project, organization or folder
  if (risk.scope) {
    const id = risk.targets[0]
    if (id && risk.scope === 'project') {
      const d = await lookup($, projectDescribeArgv(id, risk.flags))
      if (d && d.exitCode === 0) {
        try {
          const o = JSON.parse(d.stdout) as Record<string, unknown>
          pushLine(report, [String(o.name ?? id), String(o.lifecycleState ?? o.state ?? ''), o.createTime ? t(lang, 'line.created', { date: String(o.createTime).slice(0, 10) }) : ''].filter(Boolean).join(' · '))
        } catch {}
      } else if (d) report.notes.push(isNotFound(d.stderr) ? t(lang, 'note.notFound', { target: id }) : t(lang, 'note.describeFailed', { target: id, err: lastLine(d.stderr) }))
      const s = await lookup($, servicesListArgv(id, risk.flags))
      if (s && s.exitCode === 0) pushLine(report, t(lang, 'line.servicesEnabled', { n: s.stdout.split('\n').filter(l => l.trim()).length }))
      report.notes.push(t(lang, 'note.projectRecovery'))
    }
    return report
  }

  // gcloud config set: the current value of the property
  if (risk.kind === 'local-config') {
    const property = risk.targets[0]
    if (property && risk.verb !== 'activate') {
      const cur = await lookup($, configGetArgv(property, risk.flags))
      const current = cur && cur.exitCode === 0 && cur.stdout.trim() ? cur.stdout.trim() : t(lang, 'value.unknown')
      report.headline = headline(lang, risk, current)
      pushLine(report, t(lang, 'line.property', { property, current, value: risk.verb === 'unset' ? '(unset)' : (risk.targets[1] ?? '?') }))
    }
    return report
  }

  // Storage: count the objects under the sources
  if (risk.kind === 'storage') {
    if (isRsyncDelete(risk)) report.notes.push(t(lang, 'note.rsyncDelete'))
    if (risk.verb === 'rm' || risk.verb === 'rb' || risk.verb === 'mv' || risk.verb === 'rsync') {
      for (const url of storageUrls(risk).slice(0, MAX_TARGETS_DESCRIBED)) {
        const r = await lookup($, listObjectsArgv(risk, url))
        if (r && r.exitCode === 0) {
          const { n, cut } = countObjects(r.stdout)
          pushLine(report, cut ? t(lang, 'line.objectsMore', { url, n }) : t(lang, 'line.objects', { url, n }))
        } else if (r) report.notes.push(isNotFound(r.stderr) ? t(lang, 'note.notFound', { target: url }) : t(lang, 'note.listFailed', { url, err: lastLine(r.stderr) }))
      }
    }
    return report
  }

  // IAM: the member and role; for set-iam-policy the policy file against the current policy
  if (risk.kind === 'iam' && risk.tool === 'gcloud') {
    const member = risk.extra.member
    const role = risk.extra.role
    if (typeof member === 'string') pushLine(report, t(lang, 'line.member', { member }))
    if (typeof role === 'string') pushLine(report, t(lang, 'line.role', { role }))
    const target = risk.targets[0]
    if (target && risk.verb === 'set-iam-policy') {
      const file = risk.targets[1]
      let inFile = '?'
      if (file) {
        try {
          const text = await $.fs.read(file)
          const o = JSON.parse(String(text)) as Record<string, unknown>
          inFile = String(Array.isArray(o.bindings) ? (o.bindings as unknown[]).length : 0)
        } catch {}
      }
      const cur = await lookup($, getIamPolicyArgv(risk, target))
      let current = '?'
      if (cur && cur.exitCode === 0) {
        try {
          const o = JSON.parse(cur.stdout) as Record<string, unknown>
          current = String(Array.isArray(o.bindings) ? (o.bindings as unknown[]).length : 0)
        } catch {}
      }
      pushLine(report, t(lang, 'line.policyFile', { file: file ?? '?', n: inFile, current }))
    } else if (target) {
      await describeTargets($, risk, report, [target])
    }
    return report
  }

  // Create-class: what is being asked for
  if (risk.severity === 'create') {
    const flags = keyFlagsLine(risk)
    if (flags) pushLine(report, `${t(lang, 'label.flags')}: ${flags}`)
    return report
  }

  // Delete- and update-class: the current state of each target
  await describeTargets($, risk, report, risk.targets)
  return report
}

async function describeTargets($: any, risk: Risk, report: Report, targets: string[]): Promise<void> {
  if (!targets.length || !risk.path.length) return
  for (const target of targets.slice(0, MAX_TARGETS_DESCRIBED)) {
    const d = await lookup($, describeArgv(risk, target))
    if (d === null) {
      report.notes.push(t(lang, 'note.noGcloud'))
      return
    }
    if (d.exitCode !== 0) {
      report.notes.push(isNotFound(d.stderr) ? t(lang, 'note.notFound', { target }) : t(lang, 'note.describeFailed', { target, err: lastLine(d.stderr) }))
      continue
    }
    try {
      const { line, notes } = summarizeDescribe(lang, target, JSON.parse(d.stdout))
      pushLine(report, line)
      report.notes.push(...notes)
    } catch {
      pushLine(report, target)
    }
  }
  if (targets.length > MAX_TARGETS_DESCRIBED) pushLine(report, t(lang, 'more', { n: targets.length - MAX_TARGETS_DESCRIBED }))
}

// ── Drawing ────────────────────────────────────────────────────────────────

function severityColor(severity: Risk['severity']): string {
  return severity === 'destructive' ? 'red' : severity === 'mutating' ? 'yellow' : 'green'
}

function draw($: any, e: any, view: HeldView, columns: number, gke: GcloudContext['kube'] | null) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const L = lang
  const risk = view.risk
  const report = view.report
  const color = severityColor(risk.severity)
  const ctx = report?.context ?? emptyContext(risk)
  const unknown = t(L, 'value.unknown')
  const projectSource = ctx.projectSource === 'flag' ? t(L, 'source.flag') : ctx.projectSource === 'config' ? t(L, 'source.config') : ''
  const location = ctx.location ?? t(L, 'value.default')
  const decide = (choice: Decision) => () => {
    if (held && held.view.id === view.id && held.decision === null) held.decision = choice
  }
  const rows: any[] = []
  rows.push(
    <Text key="title" bold color={color}>
      {t(L, 'title', { severity: severityLabel(L, risk.severity) })}
    </Text>,
  )
  rows.push(
    <Text key="head" bold color={color} wrap="truncate-end">
      {report?.headline ?? headline(L, risk)}
    </Text>,
  )
  rows.push(
    <Text key="cmd" wrap="truncate-end">
      <Text dimColor>{`${t(L, 'label.command')}  `}</Text>
      <Text bold>{truncate(view.command, Math.max(20, columns - 12))}</Text>
    </Text>,
  )
  rows.push(
    <Text key="account" wrap="truncate-end">
      <Text dimColor>{`${t(L, 'label.account')}  `}</Text>
      <Text>{ctx.account ?? unknown}</Text>
      {ctx.impersonate ? <Text dimColor>{`  (impersonating ${ctx.impersonate})`}</Text> : null}
    </Text>,
  )
  rows.push(
    <Text key="project" wrap="truncate-end">
      <Text dimColor>{`${t(L, 'label.project')}  `}</Text>
      <Text bold>{ctx.project ?? unknown}</Text>
      {projectSource ? <Text dimColor>{`  ${projectSource}`}</Text> : null}
      {ctx.configuration ? <Text dimColor>{`  · ${t(L, 'label.configuration')} ${ctx.configuration}`}</Text> : null}
    </Text>,
  )
  rows.push(
    <Text key="location" wrap="truncate-end">
      <Text dimColor>{`${t(L, 'label.location')}  `}</Text>
      <Text>{location}</Text>
      {ctx.track !== 'ga' ? <Text color="magenta">{`  · ${t(L, 'label.track')} ${ctx.track}`}</Text> : null}
    </Text>,
  )
  if (gke && gke.kind === 'gke') {
    rows.push(
      <Text key="gke" wrap="truncate-end">
        <Text dimColor>{`${t(L, 'label.gke')}  `}</Text>
        <Text>{`${gke.cluster} (${gke.location})`}</Text>
        {gke.project && ctx.project && gke.project !== ctx.project ? <Text color="yellow">{`  ≠ ${t(L, 'label.project').toLowerCase()} ${gke.project}`}</Text> : null}
      </Text>,
    )
  }
  if (ctx.quiet) {
    rows.push(
      <Text key="quiet" color="yellow">
        {t(L, 'quiet.warn')}
      </Text>,
    )
  }
  if (report && report.lines.length) {
    rows.push(
      <Box key="lines" flexDirection="column" marginTop={1}>
        {report.lines.map((line, i) => (
          <Text key={`l${i}`} wrap="truncate-end">
            {`  ${line}`}
          </Text>
        ))}
      </Box>,
    )
  }
  if (report && report.notes.length) {
    rows.push(
      <Box key="notes" flexDirection="column">
        {report.notes.map((note, i) => (
          <Text key={`n${i}`} dimColor italic wrap="wrap">
            {note}
          </Text>
        ))}
      </Box>,
    )
  }
  if (!report) {
    rows.push(
      <Text key="measuring" dimColor>
        …
      </Text>,
    )
  }
  rows.push(
    <Box key="buttons" marginTop={1} gap={2}>
      <Button key="proceed" label={t(L, 'btn.proceed')} hotkey="1" plain onPress={decide('proceed')} />
      <Button key="cancel" label={t(L, 'btn.cancel')} hotkey="2" plain autoFocus onPress={decide('cancel')} />
      <Text key="hint" dimColor>
        {t(L, 'waiting')}
      </Text>
    </Box>,
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {rows}
    </Box>
  )
}

// ── The hold ───────────────────────────────────────────────────────────────

async function sleepTick($: any): Promise<void> {
  await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
}

async function holdCommand($: any, e: any, next: any, risk: Risk): Promise<any> {
  const command = String(e.command ?? '')
  // One hold at a time: wait for the one in progress (a subagent's, say). `held` is claimed
  // with no await between the check and the claim, so two waiting calls never both get through.
  while (held !== null) {
    if (next.signal.aborted) return { deny: denyText(lang, 'interrupted', headline(lang, risk), risk.flags.project ?? null) }
    await sleepTick($)
  }
  holdSeq += 1
  const view: HeldView = { id: holdSeq, command, risk, report: null, where: 'pane' }
  const mine: Hold = { view, decision: null }
  held = mine
  let opened: { isPlaced?: boolean } = { isPlaced: false }
  let report: Report | null = null
  try {
    report = await measure($, risk)
    mine.view = { ...mine.view, report }
    await update($, heldState, () => mine.view)
    try {
      const snap = (await read($, contextState)) as GcloudContext | null
      opened = await $.ui.open({ id: PANE, title: `gcloud-guard · ${severityLabel(lang, risk.severity)}`, focus: true, rows: paneRows(report, snap?.kube?.kind === 'gke') })
    } catch {
      opened = { isPlaced: false }
    }
    if (!opened.isPlaced) {
      mine.view = { ...mine.view, where: 'band' }
      await update($, heldState, () => mine.view)
    }
    try {
      $.ui.invalidate('ui.render')
    } catch {}
    const startedAt: number = await $.clock.now()
    while (mine.decision === null) {
      if (next.signal.aborted) {
        mine.decision = 'interrupted'
        break
      }
      if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
        mine.decision = 'timeout'
        break
      }
      await sleepTick($)
    }
  } catch {
    mine.decision = 'error'
  } finally {
    // Close this hold's pane before releasing the hold, so the next hold's pane is never the one closed
    try {
      if (opened.isPlaced) await $.ui.close({ id: PANE })
    } catch {}
    if (held === mine) held = null
    try {
      await update($, heldState, () => null)
    } catch {}
    try {
      $.ui.invalidate('ui.render')
    } catch {}
  }
  const decision = mine.decision ?? 'error'
  if (decision === 'proceed') {
    toast($, t(lang, 'toast.proceed'))
    const ran = await next(e)
    // A proceeded gcloud / gsutil command may have changed the project, account or kube context
    await refreshContext($)
    return ran
  }
  const why = decision === 'cancel' ? 'cancel' : decision === 'timeout' ? 'timeout' : decision === 'interrupted' ? 'interrupted' : 'error'
  return { deny: denyText(lang, why, report?.headline ?? headline(lang, risk), report?.context.project ?? risk.flags.project ?? null) }
}

// ── Hooks ──────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  settings = readSettings(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    lang = await resolveLanguage($)
    await update($, langState, () => lang)
    // A hot reload mid-hold left a stale view behind: clear it
    await update($, heldState, () => null)
    await $.command.register({ name: 'gcloud-guard', description: t(lang, 'cmd.description'), argumentHint: '[off|on|refresh]' })
    await refreshContext($)
    // Nobody looks at the band in `claude -p`: no timer there
    if (e.isInteractive) {
      $.clock.every(CONTEXT_TICK_MS, () => {
        void onContextTick($).catch(() => {})
      })
    }
    return out
  })

  on('command.run', { command: 'gcloud-guard' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (arg === 'off') {
      await update($, isBandHidden, () => true)
      return { text: t(lang, 'cmd.off') }
    }
    if (arg === 'on') {
      await update($, isBandHidden, () => false)
      return { text: t(lang, 'cmd.on') }
    }
    if (arg === 'refresh') {
      await refreshContext($)
      return { text: `${t(lang, 'cmd.refreshed')}\n${contextText(lang, (await read($, contextState)) as GcloudContext | null, settings)}` }
    }
    if (arg !== '') return { text: t(lang, 'cmd.usage') }
    return { text: contextText(lang, (await read($, contextState)) as GcloudContext | null, settings) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const risk = classify(command, settings)
    if (risk !== null && isHeld(risk, settings)) return holdCommand($, e, next, risk)
    if (!touchesContext(command)) return next(e)
    // Not held, but it may change the project, account or kube context: re-read afterwards
    const ran = await next(e)
    await refreshContext($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: 'gcloud-guard' }, async ($, e, next) => {
    const view = (await read($, heldState)) as HeldView | null
    if (view === null) return next(e)
    await read($, langState)
    const snap = (await read($, contextState)) as GcloudContext | null
    return draw($, e, view, e.props.bodyColumns ?? 80, snap?.kube ?? null)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = (await read($, heldState)) as HeldView | null
    await read($, langState)
    if (view !== null) {
      if (view.where !== 'band') return next(e)
      // The report takes the whole band while the command is held: the buttons must be on top
      const snap = (await read($, contextState)) as GcloudContext | null
      return draw($, e, view, e.props.bodyColumns ?? 80, snap?.kube ?? null)
    }
    if (e.props.hasSurvey || !settings.showContext || (await read($, isBandHidden))) return next(e)
    const text = contextLine(lang, (await read($, contextState)) as GcloudContext | null, settings)
    if (text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // AbovePrompt is a chain: draw our line, then whatever the plugins beneath drew, with a rule between
    const below = await next(e)
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
}
