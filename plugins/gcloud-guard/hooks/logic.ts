// gcloud-guard pure functions: tokenizer, segment splitting, the gcloud / gsutil
// classifier, the argv of the read-only lookups, and the report text.
// No `$` here; shared with register.tsx and the tests.

import type { GcloudContext, GuardTool, KubeContext, Report, ReportContext, Risk, RiskFlags, Severity, Track } from '../types'
import { t } from './i18n'
import type { Lang } from './i18n'

export type { GcloudContext, GuardTool, KubeContext, Report, ReportContext, Risk, RiskFlags, Severity, Track }

/** The context line is re-read when one of its files changed; the timer looks every 5 seconds. */
export const CONTEXT_TICK_MS = 5000

export const PLUGIN = 'gcloud-guard'
export const PANE = 'gcloud-guard'
export const HOLD_LIMIT_MS = 10 * 60 * 1000
export const POLL_SECONDS = '0.25'
export const MAX_TARGETS_DESCRIBED = 5
export const MAX_LINES = 12
export const MAX_OBJECTS_COUNTED = 2000
export const DEFAULT_DESCRIBE_TIMEOUT_S = 15
export const MIN_DESCRIBE_TIMEOUT_S = 3
export const MAX_DESCRIBE_TIMEOUT_S = 60

// ── Settings ───────────────────────────────────────────────────────────────

export type HoldLevel = 'all' | 'mutating' | 'destructive'

export type Settings = {
  language: unknown
  hold: HoldLevel
  includeGsutil: boolean
  holdConfigSet: boolean
  describeTimeoutMs: number
  showContext: boolean
  showOtherContexts: boolean
  /** How the context line is framed (`band_style`); the hold report draws its own box. */
  bandStyle: BandStyle
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

export function readSettings(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const o = options ?? {}
  const hold = o.hold === 'mutating' || o.hold === 'destructive' ? o.hold : 'all'
  const seconds = Math.min(MAX_DESCRIBE_TIMEOUT_S, Math.max(MIN_DESCRIBE_TIMEOUT_S, num(o.describe_timeout_seconds, DEFAULT_DESCRIBE_TIMEOUT_S)))
  return {
    language: o.language,
    hold,
    includeGsutil: bool(o.include_gsutil, true),
    holdConfigSet: bool(o.hold_config_set, true),
    describeTimeoutMs: Math.round(seconds * 1000),
    showContext: bool(o.show_context, true),
    showOtherContexts: bool(o.show_other_contexts, false),
    bandStyle: parseBandStyle(o.band_style),
  }
}

/** True when the current GKE context points at a project other than the one gcloud is set to. */
export function kubeProjectMismatch(ctx: GcloudContext | null): boolean {
  if (!ctx || !ctx.project || ctx.kube?.kind !== 'gke') return false
  return !!ctx.kube.project && ctx.kube.project !== ctx.project
}

/** Whether a risk of this severity is held under the configured level. */
export function isHeld(risk: Risk, settings: Settings): boolean {
  if (risk.kind === 'local-config' && !settings.holdConfigSet) return false
  if (settings.hold === 'destructive') return risk.severity === 'destructive'
  if (settings.hold === 'mutating') return risk.severity !== 'create'
  return true
}

// ── Text ───────────────────────────────────────────────────────────────────

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`
}

export function baseName(s: string): string {
  return s.slice(s.lastIndexOf('/') + 1)
}

/** Splits one segment into words, honouring double and single quotes. Good enough to read flags and names. */
export function tokenize(text: string): string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) words.push(m[1] ?? m[2] ?? m[3] ?? '')
  return words
}

/** The command line split on &&, ||, ;, | and newlines (quotes are not honoured here, as in the shell's coarse view). */
export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map(s => s.trim())
    .filter(Boolean)
}

// sudo options that take a value, so the value is not read as the command.
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!'])

/** Strips VAR=value, sudo, nice, env/exec/nohup/time and ( { wrappers from the front of a segment's words. */
export function stripWrappers(input: readonly string[]): string[] {
  const words = [...input]
  while (words.length && /^[({]+$/.test(words[0] as string)) words.shift()
  if (words.length) words[0] = (words[0] as string).replace(/^[({]+/, '')
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) words.shift()
  if (words[0] === 'sudo') {
    words.shift()
    while (words.length && (words[0] as string).startsWith('-')) {
      const option = words.shift() as string
      if (SUDO_VALUE_OPTIONS.has(option)) words.shift()
    }
  }
  while (words.length && (PREFIXES.has(words[0] as string) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string))) words.shift()
  if (words[0] === 'nice') {
    words.shift()
    const after: string | undefined = words[0]
    if (after === '-n') words.splice(0, 2)
    else if (/^-\d+$/.test(after ?? '')) words.shift()
  }
  if (words.length) {
    const last = words.length - 1
    words[last] = (words[last] as string).replace(/[)}]+$/, '')
    if (words[last] === '') words.pop()
  }
  return words
}

// ── gcloud vocabulary ──────────────────────────────────────────────────────

/** Groups whose commands only touch the local machine: credentials, the SDK itself, help. Never held. */
const LOCAL_GROUPS = new Set(['auth', 'components', 'help', 'info', 'version', 'feedback', 'topic', 'cheat-sheet', 'survey', 'interactive', 'meta', 'emulators', 'init', 'docker'])

/** Verbs that only read. Always win. */
export const READ_ONLY_VERBS = new Set([
  'describe', 'list', 'get', 'get-iam-policy', 'get-value', 'get-ancestors', 'get-ancestors-iam-policy', 'get-credentials',
  'ls', 'cat', 'stat', 'du', 'hash', 'version', 'info', 'help', 'read', 'tail', 'print-access-token', 'print-identity-token',
  'print-settings', 'check', 'test-iam-permissions', 'ssh', 'scp', 'logs', 'log', 'explain', 'lint', 'search', 'query',
  'diff', 'which', 'lookup', 'sign-blob', 'sign-jwt', 'generate-id-token', 'wait', 'stream-logs', 'get-serial-port-output',
  'tail-serial-port-output', 'get-guest-attributes', 'get-shielded-identity', 'get-screenshot', 'get-config', 'sign-url',
  'exists', 'validate', 'preview', 'simulate', 'dry-run', 'show', 'export-schema',
])
const READ_ONLY_PREFIXES = ['list-', 'describe-', 'get-', 'print-', 'show-', 'check-', 'test-', 'verify-', 'search-', 'lookup-', 'explain-', 'tail-', 'fetch-']

export const DESTRUCTIVE_VERBS = new Set([
  'delete', 'remove', 'destroy', 'purge', 'rm', 'rb', 'reset', 'abandon', 'cancel', 'revoke', 'wipe', 'detach', 'rollback',
  'erase', 'unregister', 'unbind', 'uninstall', 'terminate', 'kill', 'drop', 'truncate', 'evict', 'teardown', 'expire', 'unlink',
])
const DESTRUCTIVE_PREFIXES = ['remove-', 'delete-', 'detach-', 'revoke-', 'unregister-', 'unbind-', 'drop-', 'purge-', 'destroy-']

export const MUTATING_VERBS = new Set([
  'update', 'patch', 'set', 'enable', 'disable', 'start', 'stop', 'suspend', 'resume', 'resize', 'move', 'rename', 'promote',
  'failover', 'restart', 'reboot', 'attach', 'migrate', 'apply', 'replace', 'restore', 'import', 'export', 'upload', 'rotate',
  'activate', 'deactivate', 'deploy', 'submit', 'unset', 'rsync', 'cp', 'mv', 'setmeta', 'undelete', 'execute', 'run', 'trigger', 'edit',
  'bind', 'grant', 'install', 'upgrade', 'downgrade', 'lock', 'unlock', 'scale', 'drain', 'cordon', 'uncordon', 'approve',
  'reject', 'abort', 'retry', 'rerun', 'recreate', 'reconcile', 'sync', 'flush', 'refresh', 'repair', 'recover', 'reload',
  'redeploy', 'override', 'acquire', 'release', 'renew', 'extend', 'pause', 'unpause', 'simulate-maintenance-event',
  'send', 'perform', 'invalidate', 'modify', 'transfer', 'label', 'tag', 'compose', 'rewrite', 'setup', 'configure', 'mark',
  'ack', 'seek', 'pull-and-ack', 'modify-ack-deadline', 'modify-message-ack-deadline', 'modify-push-config',
  'add-iam-policy-binding', 'remove-iam-policy-binding', 'set-iam-policy',
])
const MUTATING_PREFIXES = ['update-', 'set-', 'add-', 'attach-', 'start-', 'stop-', 'enable-', 'disable-', 'restore-', 'resize-',
  'rotate-', 'move-', 'import-', 'export-', 'upload-', 'apply-', 'replace-', 'promote-', 'suspend-', 'resume-', 'migrate-',
  'modify-', 'reset-', 'simulate-', 'send-', 'trigger-', 'bind-', 'grant-', 'install-', 'upgrade-', 'lock-', 'unlock-', 'scale-',
  'approve-', 'reject-', 'abort-', 'retry-', 'sync-', 'flush-', 'refresh-', 'repair-', 'recover-', 'reload-', 'override-',
  'acquire-', 'release-', 'renew-', 'extend-', 'pause-', 'unpause-', 'mark-', 'ack-', 'seek-', 'configure-', 'setup-']

export const CREATE_VERBS = new Set(['create', 'add', 'insert', 'mb', 'clone', 'snapshot', 'publish', 'register', 'copy', 'reserve', 'provision', 'generate', 'issue', 'mint'])
const CREATE_PREFIXES = ['create-', 'clone-', 'snapshot-', 'register-', 'provision-', 'generate-']

/** Flags that never take a value (so the next word is not swallowed). `--no-*`, `--enable-*` and the like are handled by prefix. */
const BOOL_FLAGS = new Set([
  'quiet', 'q', 'async', 'force', 'help', 'h', 'all', 'recursive', 'r', 'R', 'dry-run', 'verbose', 'v', 'to-latest',
  'delete', 'delete-unmatched-destination-objects', 'continue-on-error', 'no-clobber', 'ignore-existing', 'gzip-local',
  'm', 'n', 'd', 'a', 'f', 'p', 'u', 'preemptible', 'spot', 'interactive', 'detailed', 'uri', 'log-http', 'user-output-enabled',
  'allow-unauthenticated', 'ingress-internal', 'cpu-throttling', 'clear-labels', 'clear-env-vars', 'clear-secrets', 'clear-tags',
  'await', 'keep-disks', 'strict', 'exact', 'readonly', 'public', 'private', 'yes', 'y', 'global', 'default', 'primary',
])
const BOOL_PREFIXES = ['no-', 'enable-', 'disable-', 'allow-', 'use-', 'skip-', 'clear-', 'is-', 'include-', 'exclude-', 'with-', 'without-', 'auto-']

/** Flags whose value names the project, account or location: read into `flags`. */
const GLOBAL_VALUE_FLAGS = new Set(['project', 'account', 'configuration', 'zone', 'region', 'location', 'impersonate-service-account', 'format', 'filter', 'billing-project', 'verbosity', 'access-token-file', 'flags-file', 'limit', 'sort-by', 'page-size'])

function isBoolFlag(name: string): boolean {
  if (BOOL_FLAGS.has(name)) return true
  return BOOL_PREFIXES.some(p => name.startsWith(p))
}

function verbSeverity(verb: string): { severity: Severity; readOnly?: true } | null {
  if (READ_ONLY_VERBS.has(verb) || READ_ONLY_PREFIXES.some(p => verb.startsWith(p))) return { severity: 'create', readOnly: true }
  if (verb === 'undelete') return { severity: 'mutating' }
  if (DESTRUCTIVE_VERBS.has(verb) || DESTRUCTIVE_PREFIXES.some(p => verb.startsWith(p))) return { severity: 'destructive' }
  if (MUTATING_VERBS.has(verb) || MUTATING_PREFIXES.some(p => verb.startsWith(p))) return { severity: 'mutating' }
  if (CREATE_VERBS.has(verb) || CREATE_PREFIXES.some(p => verb.startsWith(p))) return { severity: 'create' }
  return null
}

/** Verb stems that mean "do something to the resource", for a verb the table does not know. */
const ACTION_STEMS = new Set(['simulate', 'send', 'trigger', 'run', 'execute', 'perform', 'apply', 'reset', 'invoke', 'modify', 'replace',
  'attach', 'detach', 'bind', 'unbind', 'grant', 'revoke', 'lock', 'unlock', 'register', 'unregister', 'install', 'uninstall', 'upgrade',
  'downgrade', 'scale', 'drain', 'cordon', 'uncordon', 'provision', 'deprovision', 'approve', 'reject', 'promote', 'abort', 'retry',
  'rerun', 'recreate', 'reconcile', 'sync', 'seal', 'unseal', 'rotate', 'flush', 'truncate', 'refresh', 'repair', 'repack', 'vacuum',
  'convert', 'transform', 'encrypt', 'recover', 'restore', 'reload', 'redeploy', 'override', 'acquire', 'release', 'renew', 'extend',
  'reduce', 'increase', 'decrease', 'shrink', 'grow', 'expand', 'pause', 'unpause', 'terminate', 'kill', 'drop', 'evict', 'migrate',
  'patch', 'update', 'set', 'add', 'remove', 'delete', 'create', 'enable', 'disable', 'start', 'stop', 'resume', 'suspend'])

/** Groups whose commands can reach cloud resources; an unknown action verb under one of these is held to be safe. */
const KNOWN_GROUPS = new Set(['compute', 'container', 'run', 'sql', 'storage', 'iam', 'projects', 'functions', 'pubsub', 'redis', 'memcache',
  'spanner', 'bigtable', 'firestore', 'datastore', 'dataproc', 'dataflow', 'composer', 'scheduler', 'tasks', 'secrets', 'kms', 'dns',
  'domains', 'app', 'builds', 'artifacts', 'deploy', 'workflows', 'eventarc', 'logging', 'monitoring', 'services', 'resource-manager',
  'organizations', 'folders', 'billing', 'filestore', 'netapp', 'apigee', 'ai', 'ai-platform', 'notebooks', 'workstations', 'batch',
  'vmware', 'bms', 'transfer', 'certificate-manager', 'endpoints', 'api-gateway', 'access-context-manager', 'identity', 'beyondcorp',
  'essential-contacts', 'asset', 'recommender', 'scc', 'source', 'firebase', 'healthcare', 'lifesciences', 'alloydb', 'datastream',
  'data-catalog', 'dataplex', 'looker', 'iap', 'privateca', 'network-security', 'network-services', 'network-connectivity',
  'infra-manager', 'edge-cache', 'bq', 'gke-hub', 'fleet', 'anthos', 'backup-dr', 'parallelstore', 'memorystore', 'developer-connect',
  'immersive-stream', 'media', 'migration', 'policy-intelligence', 'policy-troubleshoot', 'publicca', 'quotas', 'runtime-config',
  'service-directory', 'service-extensions', 'telco-automation', 'colab', 'database-migration', 'dataplex', 'edge-container', 'ids',
  'metastore', 'ml', 'ml-engine', 'oracle-database', 'managed-kafka', 'netapp', 'org-policies', 'recaptcha', 'resource-settings',
  'storage-insights', 'web-security-scanner', 'workload-certificate', 'workspace-add-ons'])

const STORAGE_VERBS = new Set(['rm', 'rb', 'mb', 'cp', 'mv', 'rsync', 'setmeta', 'compose', 'rewrite', 'ls', 'cat', 'stat', 'du', 'hash', 'sign-url'])

// ── gcloud ─────────────────────────────────────────────────────────────────

type Parsed = {
  track: Track
  path: string[]
  verb: string | null
  targets: string[]
  flags: RiskFlags
  extra: Record<string, string | true>
}

/** Reads the words after `gcloud`: the release track, the group path, the verb, the targets and the flags. */
export function parseGcloudArgs(args: readonly string[]): Parsed {
  const out: Parsed = { track: 'ga', path: [], verb: null, targets: [], flags: { quiet: false }, extra: {} }
  let i = 0
  if (args[0] === 'alpha' || args[0] === 'beta') {
    out.track = args[0]
    i = 1
  }
  const setGlobal = (name: string, value: string | true) => {
    if (value === true) return
    if (name === 'project') out.flags.project = value
    else if (name === 'account') out.flags.account = value
    else if (name === 'configuration') out.flags.configuration = value
    else if (name === 'zone') out.flags.zone = value
    else if (name === 'region') out.flags.region = value
    else if (name === 'location') out.flags.location = value
    else if (name === 'impersonate-service-account') out.flags.impersonate = value
  }
  for (; i < args.length; i += 1) {
    const w = args[i] as string
    if (w === '--') {
      for (const rest of args.slice(i + 1)) (out.verb === null ? out.path : out.targets).push(rest)
      break
    }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const name = eq === -1 ? w.slice(2) : w.slice(2, eq)
      let value: string | true = eq === -1 ? true : w.slice(eq + 1)
      if (eq === -1 && !isBoolFlag(name)) {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          value = next
          i += 1
        }
      }
      if (name === 'quiet') out.flags.quiet = true
      else if (GLOBAL_VALUE_FLAGS.has(name)) setGlobal(name, value)
      out.extra[name] = value
      continue
    }
    if (w === '-q') {
      out.flags.quiet = true
      out.extra.q = true
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      out.extra[w.slice(1)] = true
      continue
    }
    if (out.verb === null) {
      // The first word is always a group (`run`, `deploy`, `config`), even when it is also a verb elsewhere
      if (out.path.length > 0 && verbSeverity(w) !== null) out.verb = w
      else out.path.push(w)
    } else out.targets.push(w)
  }
  return out
}

function unknownVerbOf(path: readonly string[]): number {
  for (let k = 1; k < path.length; k += 1) {
    const w = path[k] as string
    const stem = w.includes('-') ? (w.split('-')[0] as string) : w
    if (ACTION_STEMS.has(stem)) return k
  }
  return -1
}

/** One gcloud segment (words after `gcloud`) to a risk, or null when it only reads or stays local. */
export function classifyGcloud(args: readonly string[], raw: string, settings: Settings): Risk | null {
  const p = parseGcloudArgs(args)
  const group = p.path[0] ?? ''
  if (LOCAL_GROUPS.has(group)) return null
  const base: Omit<Risk, 'severity' | 'verb'> = { tool: 'gcloud', track: p.track, path: p.path, targets: p.targets, flags: p.flags, extra: p.extra, raw }

  // gcloud config: only set / unset / configurations activate|create|delete|rename change what later commands hit
  if (group === 'config') {
    const sub = p.path[1]
    if (p.verb === 'set' || p.verb === 'unset' || (sub === 'configurations' && (p.verb === 'activate' || p.verb === 'create' || p.verb === 'delete' || p.verb === 'rename'))) {
      return { ...base, verb: p.verb, severity: 'mutating', kind: 'local-config' }
    }
    return null
  }

  if (p.verb === null) {
    if (!KNOWN_GROUPS.has(group)) return null
    const k = unknownVerbOf(p.path)
    if (k === -1) return null
    const verb = p.path[k] as string
    return { ...base, path: p.path.slice(0, k), targets: [...p.path.slice(k + 1), ...p.targets], verb, severity: 'mutating', kind: 'unknown', unknownVerb: true }
  }
  const sev = verbSeverity(p.verb)
  if (sev === null || sev.readOnly) return null
  const risk: Risk = { ...base, verb: p.verb, severity: sev.severity }
  void settings

  // Kinds the UI treats specially
  if (group === 'storage' && STORAGE_VERBS.has(p.verb)) risk.kind = 'storage'
  else if (p.verb === 'deploy') {
    risk.kind = 'deploy'
    risk.severity = 'mutating'
  } else if (group === 'builds' && p.verb === 'submit') {
    risk.kind = 'build'
    risk.severity = 'mutating'
  } else if (p.verb === 'add-iam-policy-binding' || p.verb === 'remove-iam-policy-binding' || p.verb === 'set-iam-policy') {
    risk.kind = 'iam'
    risk.severity = p.verb === 'remove-iam-policy-binding' ? 'destructive' : 'mutating'
  }
  // Whole-project / org / folder operations
  if (risk.severity === 'destructive' && p.path.length === 1) {
    if (group === 'projects') risk.scope = 'project'
    else if (group === 'organizations') risk.scope = 'org'
    else if (group === 'folders') risk.scope = 'folder'
  }
  return risk
}

// ── gsutil ─────────────────────────────────────────────────────────────────

/** gsutil commands whose first positional word is a sub-verb (get / set / ch / ...). */
const GSUTIL_CONFIG_CMDS = new Set(['acl', 'defacl', 'iam', 'lifecycle', 'versioning', 'web', 'cors', 'label', 'retention', 'logging',
  'requesterpays', 'ubla', 'pap', 'autoclass', 'kms', 'notification', 'hmac', 'bucketpolicyonly', 'defstorageclass', 'rpo'])
const GSUTIL_READ_ONLY = new Set(['ls', 'cat', 'stat', 'du', 'hash', 'version', 'help', 'test', 'signurl'])
const GSUTIL_GLOBAL_VALUE = new Set(['-o', '-h', '-i', '-u'])

/** One gsutil segment (words after `gsutil`) to a risk, or null. */
export function classifyGsutil(args: readonly string[], raw: string): Risk | null {
  const flags: RiskFlags = { quiet: false }
  const extra: Record<string, string | true> = {}
  let i = 0
  // Global options come before the command: -m, -q, -D, -o X, -h X, -i SA, -u PROJECT
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const w = args[i] as string
    if (GSUTIL_GLOBAL_VALUE.has(w)) {
      const v = args[i + 1] ?? ''
      if (w === '-u') flags.project = v
      if (w === '-i') flags.impersonate = v
      extra[w.slice(1)] = v
      i += 2
      continue
    }
    if (w === '-q') flags.quiet = true
    extra[w.slice(1)] = true
    i += 1
  }
  const cmd = args[i]
  if (!cmd) return null
  i += 1
  const rest = args.slice(i)
  const positional: string[] = []
  for (const w of rest) {
    if (w.startsWith('-')) extra[w.replace(/^-+/, '')] = true
    else positional.push(w)
  }
  const base = { tool: 'gsutil' as const, track: 'ga' as const, flags, extra, raw }
  if (GSUTIL_READ_ONLY.has(cmd)) return null
  if (GSUTIL_CONFIG_CMDS.has(cmd)) {
    const sub = positional[0] ?? ''
    const targets = positional.slice(1)
    if (sub === 'get' || sub === 'list' || sub === '') return null
    const severity: Severity = sub === 'delete' || sub === 'clear' || sub === 'del' ? 'destructive' : sub === 'create' ? 'create' : 'mutating'
    return { ...base, path: [cmd], verb: sub, severity, kind: cmd === 'iam' || cmd === 'acl' || cmd === 'defacl' ? 'iam' : 'storage', targets }
  }
  if (cmd === 'rm' || cmd === 'rb') return { ...base, path: [], verb: cmd, severity: 'destructive', kind: 'storage', targets: positional }
  if (cmd === 'mb') return { ...base, path: [], verb: cmd, severity: 'create', kind: 'storage', targets: positional }
  if (cmd === 'cp' || cmd === 'mv' || cmd === 'rsync' || cmd === 'setmeta' || cmd === 'compose' || cmd === 'rewrite' || cmd === 'perfdiag') {
    return { ...base, path: [], verb: cmd, severity: 'mutating', kind: 'storage', targets: positional }
  }
  return null
}

// ── The command line ───────────────────────────────────────────────────────

/** The first gcloud / gsutil segment of the command line that would change something, or null. */
export function classify(command: string, settings: Settings): Risk | null {
  for (const raw of splitSegments(command)) {
    const words = stripWrappers(tokenize(raw))
    const first = words[0]
    if (!first) continue
    const cmd = first.replace(/^\\/, '')
    if (cmd === 'gcloud' || cmd.endsWith('/gcloud')) {
      const risk = classifyGcloud(words.slice(1), raw, settings)
      if (risk) return risk
      continue
    }
    if (settings.includeGsutil && (cmd === 'gsutil' || cmd.endsWith('/gsutil'))) {
      const risk = classifyGsutil(words.slice(1), raw)
      if (risk) return risk
    }
  }
  return null
}

// ── Lookups: the argv of the read-only commands ────────────────────────────

/** `--zone=…`, `--region=…`, `--location=…`, `--project=…`, `--account=…`, `--impersonate-service-account=…` as given. */
export function scopeFlags(flags: RiskFlags): string[] {
  const out: string[] = []
  if (flags.zone) out.push(`--zone=${flags.zone}`)
  if (flags.region) out.push(`--region=${flags.region}`)
  if (flags.location) out.push(`--location=${flags.location}`)
  if (flags.project) out.push(`--project=${flags.project}`)
  if (flags.account) out.push(`--account=${flags.account}`)
  if (flags.configuration) out.push(`--configuration=${flags.configuration}`)
  if (flags.impersonate) out.push(`--impersonate-service-account=${flags.impersonate}`)
  return out
}

function trackWords(track: Track): string[] {
  return track === 'ga' ? [] : [track]
}

/** `gcloud [track] <path> describe <target> --format=json <scope flags>` */
export function describeArgv(risk: Risk, target: string): string[] {
  return ['gcloud', ...trackWords(risk.track), ...risk.path, 'describe', target, '--format=json', ...scopeFlags(risk.flags)]
}

/** `gcloud [track] <path> get-iam-policy <target> --format=json <scope flags>` */
export function getIamPolicyArgv(risk: Risk, target: string): string[] {
  return ['gcloud', ...trackWords(risk.track), ...risk.path, 'get-iam-policy', target, '--format=json', ...scopeFlags(risk.flags)]
}

/** The read-only listing of a storage URL, with the tool the person used. */
export function listObjectsArgv(risk: Risk, url: string): string[] {
  if (risk.tool === 'gsutil') return ['gsutil', 'ls', '-r', url]
  return ['gcloud', 'storage', 'ls', '-r', url, ...scopeFlags(risk.flags)]
}

export function configGetArgv(property: string, flags: RiskFlags): string[] {
  const out = ['gcloud', 'config', 'get-value', property]
  if (flags.configuration) out.push(`--configuration=${flags.configuration}`)
  return out
}

export function projectDescribeArgv(id: string, flags: RiskFlags): string[] {
  const out = ['gcloud', 'projects', 'describe', id, '--format=json']
  if (flags.account) out.push(`--account=${flags.account}`)
  if (flags.impersonate) out.push(`--impersonate-service-account=${flags.impersonate}`)
  return out
}

export function servicesListArgv(id: string, flags: RiskFlags): string[] {
  const out = ['gcloud', 'services', 'list', '--enabled', `--project=${id}`, '--format=value(config.name)', '--limit=50']
  if (flags.account) out.push(`--account=${flags.account}`)
  if (flags.impersonate) out.push(`--impersonate-service-account=${flags.impersonate}`)
  return out
}

/** Whether the storage verb deletes objects at the destination (rsync -d / --delete-unmatched-destination-objects). */
export function isRsyncDelete(risk: Risk): boolean {
  return risk.verb === 'rsync' && (risk.extra.d === true || risk.extra['delete-unmatched-destination-objects'] === true)
}

/** Storage URLs among the targets (sources of rm / mv / rb / rsync, destination of cp excluded). */
export function storageUrls(risk: Risk): string[] {
  const urls = risk.targets.filter(x => x.startsWith('gs://'))
  if (risk.verb === 'cp' || risk.verb === 'mv' || risk.verb === 'rsync') return urls.slice(0, Math.max(0, urls.length - 1))
  return urls
}

/** The flags that say how big a thing is being created, for the create-class summary. */
export const KEY_CREATE_FLAGS = ['machine-type', 'size', 'tier', 'num-nodes', 'image', 'image-family', 'memory', 'cpu', 'min-instances', 'max-instances', 'disk-size', 'database-version', 'storage-size', 'node-count', 'replicas', 'capacity', 'boot-disk-size']

export function keyFlagsLine(risk: Risk): string | null {
  const parts: string[] = []
  for (const name of KEY_CREATE_FLAGS) {
    const v = risk.extra[name]
    if (v !== undefined && v !== true) parts.push(`--${name}=${v}`)
  }
  return parts.length ? parts.join(' ') : null
}

// ── Describe JSON → one line ───────────────────────────────────────────────

type Json = Record<string, unknown>

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function numOf(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return null
}

function dateOf(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? (m[1] as string) : s
}

/** A compact description of a resource from its describe JSON, and the notes it raises (deletion protection). */
export function summarizeDescribe(lang: Lang, target: string, json: unknown): { line: string; notes: string[] } {
  const o = (json && typeof json === 'object' ? json : {}) as Json
  const parts: string[] = [str(o.name) ?? target]
  const status = str(o.status) ?? str(o.state)
  if (status) parts.push(status)
  const where = str(o.zone) ?? str(o.region) ?? str(o.location) ?? str(o.locationId)
  if (where) parts.push(baseName(where))
  const machine = str(o.machineType)
  if (machine) parts.push(baseName(machine))
  const settings = (o.settings && typeof o.settings === 'object' ? o.settings : null) as Json | null
  const tier = settings ? str(settings.tier) : null
  const dbv = str(o.databaseVersion)
  if (dbv) parts.push(tier ? `${dbv} ${tier}` : dbv)
  const size = numOf(o.sizeGb) ?? numOf(o.diskSizeGb)
  if (size !== null) parts.push(`${size} GB`)
  const nodes = numOf(o.currentNodeCount) ?? numOf(o.initialNodeCount)
  if (nodes !== null) parts.push(t(lang, 'line.nodes', { n: nodes }))
  const created = dateOf(o.creationTimestamp) ?? dateOf(o.createTime)
  if (created) parts.push(t(lang, 'line.created', { date: created }))
  const labels = o.labels && typeof o.labels === 'object' ? Object.keys(o.labels as Json).length : 0
  if (labels) parts.push(t(lang, 'line.labels', { n: labels }))
  const disks = Array.isArray(o.disks) ? (o.disks as Json[]) : null
  if (disks && disks.length) parts.push(t(lang, 'line.disks', { n: disks.length, autoDelete: disks.filter(d => d.autoDelete === true).length }))
  const bindings = Array.isArray(o.bindings) ? (o.bindings as unknown[]).length : null
  if (bindings !== null) parts.push(t(lang, 'line.bindings', { n: bindings }))
  const notes: string[] = []
  if (o.deletionProtection === true || o.deleteProtection === true || (settings && settings.deletionProtectionEnabled === true)) {
    notes.push(t(lang, 'note.deletionProtection', { target }))
  }
  return { line: parts.join(' · '), notes }
}

/** Whether a failed describe says the resource does not exist. */
export function isNotFound(stderr: string): boolean {
  return /not found|notfound|404|does not exist|could not fetch resource/i.test(stderr)
}

/** The objects a storage listing holds: lines that are object URLs, not bucket or prefix headers. */
export function countObjects(stdout: string): { n: number; cut: boolean } {
  let n = 0
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('gs://') || s.endsWith('/') || s.endsWith(':')) continue
    n += 1
    if (n >= MAX_OBJECTS_COUNTED) return { n, cut: true }
  }
  return { n, cut: false }
}

// ── Report text ────────────────────────────────────────────────────────────

export function severityLabel(lang: Lang, severity: Severity): string {
  return t(lang, severity === 'destructive' ? 'severity.destructive' : severity === 'mutating' ? 'severity.mutating' : 'severity.create')
}

export function typeLabel(risk: Risk): string {
  if (risk.tool === 'gsutil') return risk.path.length ? `gsutil ${risk.path.join(' ')}` : 'gsutil'
  return risk.path.join(' ') || 'gcloud'
}

export function targetsLabel(risk: Risk, max = 4): string {
  const list = risk.targets
  if (!list.length) return ''
  const shown = list.slice(0, max).map(x => truncate(x, 48))
  return list.length > max ? `${shown.join(', ')} (+${list.length - max})` : shown.join(', ')
}

/** The headline of the pane and of the refusal. `current` is the current config value for a local-config change. */
export function headline(lang: Lang, risk: Risk, current: string | null = null): string {
  const type = typeLabel(risk)
  const targets = targetsLabel(risk)
  if (risk.scope === 'project') return t(lang, 'headline.project', { id: risk.targets[0] ?? '?' })
  if (risk.scope === 'org' || risk.scope === 'folder') return t(lang, 'headline.org', { kind: risk.scope === 'org' ? 'organization' : 'folder', id: risk.targets[0] ?? '?' })
  if (risk.kind === 'local-config') {
    const property = risk.targets[0] ?? '?'
    const value = risk.verb === 'unset' ? '(unset)' : (risk.targets[1] ?? '?')
    return t(lang, 'headline.config', { property, value, current: current ?? t(lang, 'value.unknown') })
  }
  if (risk.kind === 'deploy') return t(lang, 'headline.deploy', { type, targets })
  if (risk.kind === 'build') return t(lang, 'headline.build', { targets })
  if (risk.kind === 'iam' && risk.tool === 'gcloud') {
    const member = String(risk.extra.member ?? '?')
    const role = String(risk.extra.role ?? '?')
    if (risk.verb === 'add-iam-policy-binding') return t(lang, 'headline.iamAdd', { member, role, type, targets })
    if (risk.verb === 'remove-iam-policy-binding') return t(lang, 'headline.iamRemove', { member, role, type, targets })
    if (risk.verb === 'set-iam-policy') return t(lang, 'headline.iamSet', { type, targets: risk.targets[0] ?? '?' })
  }
  if (risk.kind === 'storage') {
    if (risk.verb === 'rm' || risk.verb === 'rb') return t(lang, 'headline.storageRm', { targets: targetsLabel(risk, 3) })
    if (risk.verb === 'cp' || risk.verb === 'mv' || risk.verb === 'rsync') return t(lang, 'headline.storageCopy', { verb: risk.verb, targets: targetsLabel(risk, 3) })
  }
  return t(lang, 'headline.generic', { verb: risk.verb, type, targets })
}

export function emptyContext(risk: Risk): ReportContext {
  return {
    account: risk.flags.account ?? null,
    project: risk.flags.project ?? null,
    projectSource: risk.flags.project ? 'flag' : 'unknown',
    configuration: risk.flags.configuration ?? null,
    location: risk.flags.zone ?? risk.flags.region ?? risk.flags.location ?? null,
    track: risk.track,
    quiet: risk.flags.quiet,
    impersonate: risk.flags.impersonate ?? null,
  }
}

/** The text of the refusal Claude reads. */
export function denyText(lang: Lang, why: 'cancel' | 'timeout' | 'interrupted' | 'error' | 'none', head: string, project: string | null): string {
  const whyKey = why === 'cancel' ? 'why.cancel' : why === 'timeout' ? 'why.timeout' : why === 'interrupted' ? 'why.interrupted' : why === 'error' ? 'why.error' : 'why.none'
  return t(lang, 'deny', { why: t(lang, whyKey), headline: head, project: project ?? t(lang, 'value.unknown') })
}

/** The rows the pane would need: title and headline, the context block, the lines, the notes, the buttons row. */
export function paneRows(report: Report | null, hasGke = false): number {
  if (!report) return 8
  return Math.min(28, 9 + report.lines.length + report.notes.length + (report.context.quiet ? 1 : 0) + (report.context.track !== 'ga' ? 1 : 0) + (hasGke ? 1 : 0))
}

// ── The context line: gcloud and kube config files ─────────────────────────

/** A gcloud configuration file (INI): `[section]` headers, `key = value` rows, `#` and `;` comments. Keys are `section/key`. */
export function parseGcloudIni(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const head = /^\[([^\]]+)\]$/.exec(line)
    if (head) {
      section = (head[1] as string).trim()
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!key) continue
    out[section ? `${section}/${key}` : key] = value
  }
  return out
}

/** The current kubectl context by name: `gke_<project>_<location>_<cluster>` is a GKE cluster, anything else is `other`. */
export function parseKubeContext(name: string): KubeContext {
  const n = name.trim()
  if (n.startsWith('gke_')) {
    const parts = n.split('_')
    // gke, project, location, then the cluster (which may hold no `_`, so the rest is joined back for safety)
    if (parts.length >= 4 && parts[1] && parts[2] && parts[3]) {
      return { kind: 'gke', name: n, project: parts[1], location: parts[2], cluster: parts.slice(3).join('_') }
    }
  }
  return { kind: 'other', name: n }
}

/** The `current-context:` line of a kubeconfig, or null. No YAML parser: one regex. */
export function currentContextOf(kubeconfigText: string): string | null {
  const m = /^\s*current-context:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(kubeconfigText)
  const v = m?.[1]?.trim()
  return v ? v : null
}

/** KUBECONFIG is a colon-separated list; the first file that names a current context wins. */
export function splitKubeconfigList(value: string | undefined, home: string | null): string[] {
  const list = (value ?? '').split(':').map(s => s.trim()).filter(Boolean)
  if (list.length) return list
  return home ? [`${home.replace(/\/+$/, '')}/.kube/config`] : []
}

export type ContextEnv = {
  CLOUDSDK_CONFIG?: string
  HOME?: string
  CLOUDSDK_CORE_PROJECT?: string
  CLOUDSDK_CORE_ACCOUNT?: string
  CLOUDSDK_ACTIVE_CONFIG_NAME?: string
  CLOUDSDK_COMPUTE_ZONE?: string
  CLOUDSDK_COMPUTE_REGION?: string
}

export function gcloudConfigDir(env: ContextEnv): string | null {
  const explicit = (env.CLOUDSDK_CONFIG ?? '').trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  const home = (env.HOME ?? '').trim()
  return home ? `${home.replace(/\/+$/, '')}/.config/gcloud` : null
}

/** Builds the snapshot from the files' texts and the env; the file reads themselves are the caller's. */
export function buildContext(input: {
  env: ContextEnv
  configDir: string | null
  activeConfigText: string | null
  configText: string | null
  kubeconfigPath: string | null
  kubeconfigText: string | null
  now: number
}): GcloudContext {
  const { env } = input
  const configuration = (env.CLOUDSDK_ACTIVE_CONFIG_NAME ?? '').trim() || (input.activeConfigText ?? '').trim() || (input.configDir ? 'default' : '')
  const ini = input.configText !== null ? parseGcloudIni(input.configText) : {}
  const envProject = (env.CLOUDSDK_CORE_PROJECT ?? '').trim()
  const fileProject = (ini['core/project'] ?? '').trim()
  const project = envProject || fileProject || null
  const account = (env.CLOUDSDK_CORE_ACCOUNT ?? '').trim() || (ini['core/account'] ?? '').trim() || null
  const zone = (env.CLOUDSDK_COMPUTE_ZONE ?? '').trim() || (ini['compute/zone'] ?? '').trim() || null
  const region = (env.CLOUDSDK_COMPUTE_REGION ?? '').trim() || (ini['compute/region'] ?? '').trim() || null
  const name = input.kubeconfigText !== null ? currentContextOf(input.kubeconfigText) : null
  return {
    configDir: input.configDir,
    configuration: configuration || null,
    project,
    projectSource: project ? (envProject ? 'env' : 'file') : null,
    account,
    zone,
    region,
    kubeconfig: input.kubeconfigPath,
    kube: name ? parseKubeContext(name) : null,
    readAt: input.now,
  }
}

/** The dim line above the prompt; null when nothing is known. */
export function contextLine(lang: Lang, ctx: GcloudContext | null, settings: Settings): string | null {
  if (!ctx) return null
  const parts: string[] = []
  if (ctx.project) parts.push(`${t(lang, 'ctx.project', { project: ctx.project })}${ctx.projectSource === 'env' ? ` ${t(lang, 'ctx.fromEnv')}` : ''}`)
  if (ctx.account) parts.push(t(lang, 'ctx.account', { account: ctx.account }))
  if (ctx.configuration && (ctx.project || ctx.account)) parts.push(t(lang, 'ctx.config', { name: ctx.configuration }))
  if (ctx.kube?.kind === 'gke') parts.push(t(lang, 'ctx.gke', { cluster: ctx.kube.cluster, location: ctx.kube.location }))
  else if (ctx.kube && settings.showOtherContexts) parts.push(t(lang, 'ctx.k8s', { name: ctx.kube.name }))
  if (!parts.length) return null
  return `☁ gcloud · ${parts.join(' · ')}`
}

/** The `/gcloud-guard` output: the whole snapshot and the hold setting. */
export function contextText(lang: Lang, ctx: GcloudContext | null, settings: Settings): string {
  const none = t(lang, 'value.none')
  const lines: string[] = []
  if (!ctx || (!ctx.configDir && !ctx.project && !ctx.account)) lines.push(t(lang, 'cmd.none'))
  else {
    lines.push(t(lang, 'cmd.configDir', { dir: ctx.configDir ?? none }))
    lines.push(t(lang, 'cmd.configuration', { name: ctx.configuration ?? none }))
    lines.push(t(lang, 'cmd.project', { project: ctx.project ?? none, source: ctx.projectSource === 'env' ? t(lang, 'cmd.source.env') : t(lang, 'cmd.source.file') }))
    lines.push(t(lang, 'cmd.account', { account: ctx.account ?? none }))
    lines.push(t(lang, 'cmd.zone', { zone: ctx.zone ?? none, region: ctx.region ?? none }))
  }
  lines.push(t(lang, 'cmd.kubeconfig', { path: ctx?.kubeconfig ?? none }))
  lines.push(t(lang, 'cmd.kubeContext', { name: ctx?.kube?.name ?? none }))
  if (ctx?.kube?.kind === 'gke') lines.push(t(lang, 'cmd.gke', { project: ctx.kube.project, location: ctx.kube.location, cluster: ctx.kube.cluster }))
  lines.push(t(lang, 'cmd.hold', { hold: settings.hold, gsutil: settings.includeGsutil ? 1 : 0, configSet: settings.holdConfigSet ? 1 : 0 }))
  return lines.join('\n')
}

/** Bash commands after which the context may have changed: config, credentials, kube context switches. */
export function touchesContext(command: string): boolean {
  return /gcloud\s+(?:alpha\s+|beta\s+)?(?:config\b|auth\b|container\s+clusters\s+get-credentials)|kubectl\s+config\s+(?:use-context|set-context|set-cluster|unset)|\bkubectx\b/.test(command)
}


// ── Band framing ───────────────────────────────────────────────────────────

/** How the mod's line above the prompt is framed: a rounded box, a thin rule beneath, or bare text. */
export type BandStyle = 'box' | 'rule' | 'plain'

/** The `band_style` option; anything but `rule` or `plain` is the default box. */
export function parseBandStyle(v: unknown): BandStyle {
  return v === 'rule' || v === 'plain' ? v : 'box'
}
