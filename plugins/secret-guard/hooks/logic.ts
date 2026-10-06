// secret-guard pure logic: the detector table, `redact()`, content-block rewriting,
// settings parsing and the texts of the band and the command.
// No `$` here; shared with register.tsx and the tests.

import type { RecentHit } from '../types'
import type { Lang } from './i18n'
import { t } from './i18n'

export const PLUGIN = 'secret-guard'
export const MAX_RECENT = 100
/** How many hits `/secret-guard` (the status) lists */
export const STATUS_RECENT = 20
/** How long a recorded source may be */
export const SOURCE_MAX = 120

// ── Settings ───────────────────────────────────────────────────────────────

export type CustomRule = { label: string; regex: RegExp }

export type Settings = {
  language: unknown
  enabled: boolean
  keepHint: boolean
  entropyBackstop: boolean
  customRules: CustomRule[]
  /** `custom_patterns` lines that did not compile, as written */
  badPatterns: string[]
  allowPatterns: RegExp[]
  scanToolResults: boolean
  /** How the band line is framed (`band_style`) */
  bandStyle: BandStyle
  /** Record a per-session HMAC fingerprint of each redacted value (`fingerprints`) */
  fingerprints: boolean
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/** Compiles a regex source with the `g` flag added (and `i` kept if given as `/.../i`). */
function compile(source: string): RegExp | null {
  const text = source.trim()
  if (!text) return null
  const slashed = /^\/(.+)\/([a-z]*)$/.exec(text)
  const body = slashed ? (slashed[1] as string) : text
  const flags = new Set((slashed ? (slashed[2] as string) : '').split(''))
  flags.add('g')
  flags.delete('d')
  flags.delete('y')
  try {
    return new RegExp(body, [...flags].join(''))
  } catch {
    return null
  }
}

/** `label=regex` lines → rules; a line without `=` or with a regex that does not compile goes to `bad`. */
export function parseCustomPatterns(text: string): { rules: CustomRule[]; bad: string[] } {
  const rules: CustomRule[] = []
  const bad: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      bad.push(line)
      continue
    }
    const label = line.slice(0, eq).trim().replace(/[<>]/g, '')
    const regex = compile(line.slice(eq + 1))
    if (!label || !regex) {
      bad.push(line)
      continue
    }
    rules.push({ label, regex })
  }
  return { rules, bad }
}

export function parseAllowPatterns(text: string): RegExp[] {
  const out: RegExp[] = []
  for (const raw of text.split('\n')) {
    const r = compile(raw)
    if (r) out.push(r)
  }
  return out
}

export function readSettings(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const o = options ?? {}
  const custom = parseCustomPatterns(typeof o.custom_patterns === 'string' ? o.custom_patterns : '')
  return {
    language: o.language,
    enabled: bool(o.enabled, true),
    keepHint: bool(o.keep_hint, false),
    entropyBackstop: bool(o.entropy_backstop, true),
    customRules: custom.rules,
    badPatterns: custom.bad,
    allowPatterns: parseAllowPatterns(typeof o.allow_patterns === 'string' ? o.allow_patterns : ''),
    scanToolResults: bool(o.scan_tool_results, true),
    bandStyle: parseBandStyle(o.band_style),
    fingerprints: bool(o.fingerprints, true),
  }
}

// ── Detectors ──────────────────────────────────────────────────────────────
//
// Each detector is a global regex. The secret is the named group `secret` when
// there is one, else the whole match; the named groups `pre` and `post` are kept
// around the placeholder. `label` may depend on the match. `skip` vetoes a match;
// `when` gates the whole detector on the text (e.g. a service-account JSON).

export type Match = { whole: string; groups: Record<string, string | undefined>; offset: number; input: string }

export type Detector = {
  id: string
  label: string | ((m: Match) => string)
  regex: RegExp
  skip?: (secret: string, m: Match) => boolean
  when?: (text: string) => boolean
}

const SECRETISH = /(api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key|auth|signature|session[_-]?id|bearer|[_-]key\b|\bkey\b)/i

const isServiceAccountJson = (text: string): boolean => /"type"\s*:\s*"service_account"/.test(text)

/** A value that is plainly a stand-in, for detectors whose shape is already specific (headers, URLs): `<x>`, `${X}`, `$X`, xxx, ***, the same character repeated, example words. */
export function isObviousPlaceholder(v: string): boolean {
  const s = v.trim()
  if (!s) return true
  if (s.startsWith('<') || s.startsWith('${') || s.startsWith('{{') || s.startsWith('$') || s.startsWith('%')) return true
  if (/^(x{3,}|\*{3,}|\.{3,}|_{3,}|-{3,}|#{3,})$/i.test(s)) return true
  if (/(example|changeme|placeholder|your[_-]|dummy|sample|redacted)/i.test(s)) return true
  if (/^(.)\1+$/.test(s)) return true
  return false
}

/** Values that are clearly not a live secret: placeholders, env references, code, paths, URLs, flags. */
export function isPlaceholderValue(v: string): boolean {
  const s = v.trim()
  if (!s) return true
  if (s.startsWith('<') || s.startsWith('${') || s.startsWith('{{') || s.startsWith('$') || s.startsWith('%')) return true
  if (/^(x{3,}|\*{3,}|\.{3,}|_{3,}|-{3,}|#{3,})$/i.test(s)) return true
  if (/^(null|none|nil|undefined|true|false|empty|redacted|changeme|change-me|secret|password|token)$/i.test(s)) return true
  if (/(example|changeme|placeholder|your[_-]|dummy|sample|redacted)/i.test(s)) return true
  if (/^(.)\1+$/.test(s)) return true // all the same character
  if (/[()[\]{}]/.test(s)) return true // code: a call, an index, a block
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(s)) return true // dotted identifier: os.environ, process.env
  if (/^[A-Za-z_][A-Za-z_]*$/.test(s) && s.length < 20) return true // a bare identifier without digits
  if (/^(\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(s)) return true // a path
  if (/:\/\//.test(s) && !/:\/\/[^/\s]+:[^@/\s]+@/.test(s)) return true // a URL without credentials
  return false
}

const AWS_EXAMPLE_ID = 'AKIAIOSFODNN7EXAMPLE'
const AWS_EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

/** Documentation examples everybody pastes; never a live credential. */
export const BUILTIN_ALLOW: readonly string[] = [AWS_EXAMPLE_ID, AWS_EXAMPLE_SECRET]

export const DETECTORS: readonly Detector[] = [
  // Google Cloud service-account key file: the two key fields, the rest of the JSON stays readable
  {
    id: 'gcp-sa-private-key',
    label: 'gcp service account private key',
    regex: /(?<pre>"private_key"\s*:\s*")(?<secret>-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----(?:\\+n)?)(?<post>")/g,
    when: isServiceAccountJson,
  },
  {
    id: 'gcp-sa-private-key-id',
    label: 'gcp service account private key id',
    regex: /(?<pre>"private_key_id"\s*:\s*")(?<secret>[0-9a-fA-F]{20,})(?<post>")/g,
    when: isServiceAccountJson,
  },
  // Any PEM private key, real newlines or `\n`-escaped; certificates are not secrets
  { id: 'pem-private-key', label: 'private key', regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----(?:\\+n)?/g },
  // Google
  { id: 'google-api-key', label: 'google api key', regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  { id: 'google-oauth-access', label: 'google oauth access token', regex: /(?<![A-Za-z0-9_-])ya29\.[0-9A-Za-z_-]{20,}/g },
  { id: 'google-oauth-refresh', label: 'google oauth refresh token', regex: /(?<![A-Za-z0-9_-])1\/\/0[0-9A-Za-z_-]{20,}/g },
  { id: 'google-oauth-client-secret', label: 'google oauth client secret', regex: /(?<![A-Za-z0-9_-])GOCSPX-[0-9A-Za-z_-]{20,}/g },
  // AWS
  { id: 'aws-access-key-id', label: 'aws access key id', regex: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  {
    id: 'aws-secret-access-key',
    label: 'aws secret access key',
    regex: /(?<pre>(?:aws_secret_access_key|secretAccessKey|aws_secret_key)[^\n]{0,40}?)(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
  },
  // Model providers
  { id: 'anthropic-api-key', label: 'anthropic api key', regex: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-api-key', label: 'openai api key', regex: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  // Source forges and registries
  { id: 'github-token', label: 'github token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { id: 'gitlab-token', label: 'gitlab token', regex: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'npm-token', label: 'npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'pypi-token', label: 'pypi token', regex: /(?<![A-Za-z0-9_-])pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g },
  { id: 'huggingface-token', label: 'hugging face token', regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  // Chat and messaging
  { id: 'slack-webhook', label: 'slack webhook url', regex: /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9A-Za-z]+/g },
  { id: 'slack-token', label: 'slack token', regex: /(?<![A-Za-z0-9_-])xox[abposre]-[0-9A-Za-z-]{10,}/g },
  { id: 'telegram-bot-token', label: 'telegram bot token', regex: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // Payments, mail, telephony
  { id: 'stripe-key', label: 'stripe secret key', regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/g },
  { id: 'sendgrid-key', label: 'sendgrid api key', regex: /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  { id: 'twilio-key', label: 'twilio api key', regex: /\bSK[0-9a-f]{32}\b/g },
  // Tokens with a fixed shape (JWT before Discord: both are three dot-joined parts)
  { id: 'jwt', label: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'discord-bot-token', label: 'discord bot token', regex: /\b[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g },
  // HTTP authentication
  {
    id: 'http-authorization',
    label: m => {
      const scheme = (m.groups.scheme ?? '').toLowerCase()
      return scheme === 'bearer' ? 'bearer token' : scheme === 'basic' ? 'basic auth' : 'token'
    },
    regex: /(?<pre>Authorization\s*:\s*(?<scheme>Bearer|Basic|Token)\s+)(?<secret>[^\s'"]+)/gi,
    skip: isObviousPlaceholder,
  },
  {
    id: 'api-key-header',
    label: 'api key',
    regex: /(?<pre>\b(?:x-api-key|api-key|apikey)\s*:\s*)(?<secret>[^\s'",;]{8,})/gi,
    skip: isObviousPlaceholder,
  },
  // Credentials in a URL: scheme://user:password@host
  {
    id: 'url-credentials',
    label: 'password',
    regex: /(?<pre>[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)(?<secret>[^@\s/]+)(?<post>@)/gi,
    skip: isObviousPlaceholder,
  },
  // Generic `name = value` assignments, the lowest priority: everything above has had its turn
  {
    id: 'generic-assignment',
    label: 'secret value',
    regex:
      /(?<pre>(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|pwd|token|secret)\b(?:\s*[:=]\s*|\s*=>\s*|"\s*:\s*")['"]?)(?<secret>[^\s'"`,;]{8,})/gi,
    skip: isPlaceholderValue,
  },
]

// ── Entropy backstop ───────────────────────────────────────────────────────

/** Shannon entropy of the string, in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

const ENTROPY_MIN = 4.0
const ENTROPY_WINDOW = 60
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A file path rather than a token. Without this, a path written near a word such
 * as `secret` (a folder called secret-guard) would be taken for a high-entropy
 * secret. Two shapes: rooted (`/`, `~/`, `./`, `../`) with at least three
 * separators; or relative with at least three separators where every segment is
 * a lowercase word (`plugins/secret-guard/hooks/logic`), which random base64
 * practically never is.
 */
export function isPathLike(v: string): boolean {
  const slashes = (v.match(/\//g) ?? []).length
  if (slashes < 3) return false
  if (/^(\/|~\/|\.{1,2}\/)/.test(v)) return true
  const segments = v.split('/').filter(Boolean)
  return segments.length >= 3 && segments.every(seg => /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(seg))
}

/**
 * A long random-looking token next to a secret-ish name. Conservative: hex hashes,
 * UUIDs, base64 payloads of data URIs and tokens with no such name nearby are left alone.
 */
export const ENTROPY_DETECTOR: Detector = {
  id: 'high-entropy',
  label: 'high-entropy secret',
  // `=` is allowed only as trailing base64 padding, so `NAME=value` never becomes one token with the name
  regex: /(?<![A-Za-z0-9+/_<-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/g,
  skip: (v, m) => {
    if (/^[0-9a-fA-F]+$/.test(v)) return true
    if (UUID_RE.test(v)) return true
    if (v.startsWith('<') || v.includes('…')) return true
    if (isPathLike(v)) return true
    if (entropy(v) < ENTROPY_MIN) return true
    const before = m.input.slice(Math.max(0, m.offset - ENTROPY_WINDOW), m.offset)
    if (/base64,\s*$/.test(before)) return true
    return !SECRETISH.test(before)
  },
}

// ── redact ─────────────────────────────────────────────────────────────────

export type Hit = { label: string; count: number }

/**
 * One redacted value, as found. `value` lives only in memory, long enough for the
 * caller to fingerprint it; it is never written to state, logs or toasts.
 * `toolUseId` is set for matches inside a tool_result block.
 */
export type Found = { label: string; value: string; line: number; toolUseId?: string }
export type Redaction = { text: string; hits: Hit[]; found: Found[] }

/** 1-based line of `index` in `text`. */
export function lineOf(text: string, index: number): number {
  let n = 1
  const end = Math.min(Math.max(0, index), text.length)
  for (let i = 0; i < end; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return n
}

/**
 * The line number a person would use for `index`: Read's own number when the line
 * starts with one (`    12\t…` or `12→…`), else the offset-derived line.
 */
export function readLineNumber(text: string, index: number): number {
  const at = Math.min(Math.max(0, index), text.length)
  const start = text.lastIndexOf('\n', at - 1) + 1
  const m = /^\s*(\d+)[\t→]/.exec(text.slice(start, start + 16))
  if (m && m[1]) return Number(m[1])
  return lineOf(text, at)
}

/** The placeholder the model reads instead of the value; with `keepHint`, the last four characters ride along. */
export function placeholder(label: string, secret: string, keepHint: boolean): string {
  if (!keepHint || secret.length < 8) return `<${label}>`
  return `<${label} …${secret.slice(-4)}>`
}

function isAllowed(secret: string, settings: Settings): boolean {
  if (BUILTIN_ALLOW.includes(secret)) return true
  for (const r of settings.allowPatterns) {
    r.lastIndex = 0
    if (r.test(secret)) return true
  }
  return false
}

/** `String.replace` hands the callback (match, ...captures, offset, input, groups?); this picks them apart. */
function readArgs(args: unknown[]): Match {
  const whole = String(args[0])
  const last = args[args.length - 1]
  const hasGroups = last !== null && typeof last === 'object'
  const groups = (hasGroups ? last : {}) as Record<string, string | undefined>
  const input = String(args[hasGroups ? args.length - 2 : args.length - 1])
  const offset = Number(args[hasGroups ? args.length - 3 : args.length - 2])
  return { whole, groups, offset, input }
}

function applyDetector(text: string, d: Detector, settings: Settings, counts: Map<string, number>, found: Found[]): string {
  if (d.when && !d.when(text)) return text
  d.regex.lastIndex = 0
  return text.replace(d.regex, (...args: unknown[]) => {
    const m = readArgs(args)
    const secret = m.groups.secret ?? m.whole
    if (!secret) return m.whole
    if (isAllowed(secret, settings)) return m.whole
    if (d.skip && d.skip(secret, m)) return m.whole
    const label = typeof d.label === 'function' ? d.label(m) : d.label
    counts.set(label, (counts.get(label) ?? 0) + 1)
    found.push({ label, value: secret, line: readLineNumber(m.input, m.offset + (m.groups.pre ?? '').length) })
    return `${m.groups.pre ?? ''}${placeholder(label, secret, settings.keepHint)}${m.groups.post ?? ''}`
  })
}

/** Replaces every secret the detectors find; idempotent (placeholders never match). */
export function redact(text: string, settings: Settings): Redaction {
  if (!text) return { text, hits: [], found: [] }
  const counts = new Map<string, number>()
  const found: Found[] = []
  let out = text
  for (const d of DETECTORS) out = applyDetector(out, d, settings, counts, found)
  for (const r of settings.customRules) out = applyDetector(out, { id: `custom:${r.label}`, label: r.label, regex: r.regex }, settings, counts, found)
  if (settings.entropyBackstop) out = applyDetector(out, ENTROPY_DETECTOR, settings, counts, found)
  const hits = [...counts.entries()].map(([label, count]) => ({ label, count }))
  return { text: out, hits, found }
}

/** Sums hit lists. */
export function mergeHits(lists: readonly Hit[][]): Hit[] {
  const counts = new Map<string, number>()
  for (const list of lists) for (const h of list) counts.set(h.label, (counts.get(h.label) ?? 0) + h.count)
  return [...counts.entries()].map(([label, count]) => ({ label, count }))
}

export function hitTotal(hits: readonly Hit[]): number {
  return hits.reduce((n, h) => n + h.count, 0)
}

export function hitLabels(hits: readonly Hit[]): string {
  return hits.map(h => (h.count > 1 ? `${h.label} ×${h.count}` : h.label)).join(', ')
}

// ── Content blocks ─────────────────────────────────────────────────────────

export type Block = { type: string; [field: string]: unknown }

/**
 * Rewrites the text of `text` blocks and of `tool_result` blocks (a string, or an
 * array of text blocks). Every other block is returned as is. `changed` is false
 * when nothing was redacted, so the caller can pass the row through untouched.
 */
export function redactBlocks(
  blocks: readonly Block[],
  settings: Settings,
  toolUseId?: string,
): { blocks: Block[]; hits: Hit[]; found: Found[]; changed: boolean } {
  const all: Hit[][] = []
  const found: Found[] = []
  let changed = false
  const tag = (list: Found[], id: string | undefined) => (id === undefined ? list : list.map(f => ({ ...f, toolUseId: id })))
  const out = blocks.map(b => {
    if (b.type === 'text' && typeof b.text === 'string') {
      const r = redact(b.text, settings)
      if (!r.hits.length) return b
      changed = true
      all.push(r.hits)
      found.push(...tag(r.found, toolUseId))
      return { ...b, text: r.text }
    }
    if (b.type === 'tool_result') {
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined
      if (typeof b.content === 'string') {
        const r = redact(b.content, settings)
        if (!r.hits.length) return b
        changed = true
        all.push(r.hits)
        found.push(...tag(r.found, id))
        return { ...b, content: r.text }
      }
      if (Array.isArray(b.content)) {
        const inner = redactBlocks(b.content as Block[], settings, id)
        if (!inner.changed) return b
        changed = true
        all.push(inner.hits)
        found.push(...inner.found)
        return { ...b, content: inner.blocks }
      }
    }
    return b
  })
  return { blocks: changed ? out : [...blocks], hits: mergeHits(all), found, changed }
}

// ── Doors ──────────────────────────────────────────────────────────────────

/** The rows the model reads that a person, a tool or the engine wrote; never the model's own words or a notice. */
export const SCAN_DOORS = ['prompt', 'command', 'tool-result', 'tool-message', 'delivery', 'attachment', 'hook-context', 'note', 'compaction'] as const
/** With `scan_tool_results` off, only what the person typed or ran. */
export const PROMPT_DOORS = ['prompt', 'command'] as const

export function isScannedDoor(door: string, settings: Settings): boolean {
  const list: readonly string[] = settings.scanToolResults ? SCAN_DOORS : PROMPT_DOORS
  return list.includes(door)
}

// ── The session.append decision ────────────────────────────────────────────

export type AppendRow = { message: { content?: unknown; [k: string]: unknown }; door: string; agentId?: string; [k: string]: unknown }
export type AppendPlan = { kind: 'pass' } | { kind: 'rewrite'; input: AppendRow; hits: Hit[]; found: Found[]; where: string; agent: string | null }

/**
 * What the session.append hook should do with a row: pass it through (a door the
 * model never reads, nothing to redact, no content array) or rewrite its blocks.
 * Pure, so the tests can drive it; the hook itself only adds the `$` calls.
 */
export function planAppend(e: AppendRow, settings: Settings): AppendPlan {
  if (!isScannedDoor(String(e.door), settings)) return { kind: 'pass' }
  const content = e.message?.content
  if (!Array.isArray(content)) return { kind: 'pass' }
  const r = redactBlocks(content as Block[], settings)
  if (!r.changed) return { kind: 'pass' }
  return {
    kind: 'rewrite',
    input: { ...e, message: { ...e.message, content: r.blocks } },
    hits: r.hits,
    found: r.found,
    where: String(e.door),
    agent: typeof e.agentId === 'string' ? e.agentId : null,
  }
}

// ── Text ───────────────────────────────────────────────────────────────────

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const WHERE_KEYS = ['prompt', 'command', 'context', 'attachment', 'tool-result', 'tool-message', 'delivery', 'hook-context', 'note', 'compaction'] as const
type WhereKey = (typeof WHERE_KEYS)[number]

export function whereText(lang: Lang, where: string, agent: string | null): string {
  const key = (WHERE_KEYS as readonly string[]).includes(where) ? (`where.${where as WhereKey}` as const) : null
  const base = key ? t(lang, key) : where
  return agent ? t(lang, 'where.agent', { where: base, id: agent.slice(0, 8) }) : base
}

export function toastText(lang: Lang, hits: readonly Hit[], where: string, agent: string | null, from?: { tool?: string; source?: string }): string {
  const n = hitTotal(hits)
  const labels = hitLabels(hits)
  const base = where === 'prompt' && !agent ? t(lang, 'toast.redacted', { n, labels }) : t(lang, 'toast.redactedWhere', { n, labels, where: whereText(lang, where, agent) })
  const short = from?.tool ? shortSource(from.tool, from.source) : ''
  return short ? `${base} · ${short}` : base
}

// ── Where a hit came from ──────────────────────────────────────────────────

/**
 * What a tool call is about, for the hit record: a file path for tools that name
 * one, else a Bash command or a Grep pattern. Never the tool's output. The result
 * is redacted itself (a command line may carry a token) and cut to SOURCE_MAX.
 */
export function toolSource(tool: string, input: Readonly<Record<string, unknown>>, settings: Settings): string | undefined {
  const pick = (k: string) => (typeof input[k] === 'string' && (input[k] as string).trim() ? (input[k] as string) : undefined)
  const raw = pick('file_path') ?? pick('path') ?? pick('notebook_path') ?? (tool === 'Bash' ? pick('command') : undefined) ?? pick('pattern') ?? pick('url') ?? pick('query')
  if (raw === undefined) return undefined
  return clipMiddle(redact(raw.replace(/\s+/g, ' ').trim(), settings).text, SOURCE_MAX)
}

/**
 * Cuts the middle out of a long source so both ends survive: the start of a command
 * and the file name at the end of a path (`/private/tmp/…/scratchpad/fp-test.env`).
 */
export function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor((max - 1) * 0.35)
  const tail = max - 1 - head
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** `~` for the home directory, so the list stays short. */
export function abbreviateHome(path: string, home: string | null | undefined): string {
  if (!home) return path
  const h = home.replace(/\/+$/, '')
  if (path === h) return '~'
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path
}

/** The toast's tail: the tool and the file's base name, or the command cut short. */
export function shortSource(tool: string | undefined, source: string | undefined): string {
  if (!source) return ''
  const isPath = /^(\/|~\/|\.{1,2}\/)/.test(source) || /^[^\s]+\.[A-Za-z0-9]+$/.test(source)
  const what = isPath ? source.slice(source.lastIndexOf('/') + 1) : clip(source, 30)
  return tool ? `${tool} ${what}` : what
}

/** HH:MM in the machine's local time. */
export function clockText(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Where one hit happened, as one phrase: `Read ~/proj/.env:4`, `Bash cat .env`, `prompt`. */
export function locationText(lang: Lang, h: RecentHit, home: string | null | undefined): string {
  const parts: string[] = []
  if (h.tool) parts.push(h.tool)
  if (h.source) parts.push(`${abbreviateHome(h.source, home)}${h.line !== undefined && h.tool ? `:${h.line}` : ''}`)
  if (!h.tool && h.source === h.where) parts.length = 0
  if (!parts.length) parts.push(whereText(lang, h.where, null))
  else if (!h.tool) parts.unshift(`${whereText(lang, h.where, null)}:`)
  if (h.agent) parts.push(t(lang, 'cmd.hit.agent', { id: h.agent.slice(0, 8) }))
  return parts.join(' ')
}

/** One line of the status list: `14:02  aws secret access key  #a3f91c02  Read ~/proj/.env:4`. */
export function hitLine(lang: Lang, h: RecentHit, home: string | null | undefined): string {
  return [clockText(h.at), h.label, h.fingerprint, locationText(lang, h, home)].filter(Boolean).join('  ')
}

/**
 * `/secret-guard log`: every recorded hit, grouped by fingerprint (by label when
 * fingerprints are off), the busiest group first, each location indented.
 */
export function logText(lang: Lang, recent: readonly RecentHit[], home: string | null | undefined): string {
  if (!recent.length) return t(lang, 'cmd.status.none')
  const groups = new Map<string, { fingerprint?: string; label: string; hits: RecentHit[] }>()
  for (const h of recent) {
    const key = h.fingerprint ? `${h.fingerprint} ${h.label}` : `label:${h.label}`
    const g = groups.get(key) ?? { fingerprint: h.fingerprint, label: h.label, hits: [] }
    g.hits.push(h)
    groups.set(key, g)
  }
  const lines = [t(lang, 'cmd.log.header', { n: recent.length, groups: groups.size })]
  for (const g of [...groups.values()].sort((a, b) => b.hits.length - a.hits.length)) {
    lines.push([g.fingerprint, g.label, `×${g.hits.length}`].filter(Boolean).join('  '))
    for (const h of g.hits) lines.push(`    ${clockText(h.at)}  ${locationText(lang, h, home)}`)
  }
  return lines.join('\n')
}

// ── Fingerprints ───────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** A fresh 32-byte fingerprint key, hex. */
export function newFingerprintKey(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * HMAC-SHA256 (RFC 2104) over `crypto.subtle.digest`, the one Web Crypto call the
 * hooks environment declares: H((K ⊕ opad) ‖ H((K ⊕ ipad) ‖ m)), block size 64.
 */
export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? await sha256(key) : key)
  const ipad = block.map(b => b ^ 0x36)
  const opad = block.map(b => b ^ 0x5c)
  return sha256(concat(opad, await sha256(concat(ipad, message))))
}

/** `#` + the first 8 hex digits of HMAC-SHA256(key, value). */
export async function fingerprint(keyHex: string, value: string): Promise<string> {
  const mac = await hmacSha256(fromHex(keyHex), new TextEncoder().encode(value))
  return `#${toHex(mac).slice(0, 8)}`
}

export type BandState = { isPaused: boolean; total: number; recent: readonly RecentHit[]; badPatterns: readonly string[]; enabled: boolean }

/** The band line; null when there is nothing to say (enabled, nothing redacted, no bad pattern). */
export function bandText(lang: Lang, s: BandState): string | null {
  if (!s.enabled) return null
  if (s.isPaused) return t(lang, 'band.paused')
  if (s.badPatterns.length) return t(lang, 'band.badPatterns', { n: s.badPatterns.length, names: s.badPatterns.map(p => p.split('=')[0]).join(', ') })
  if (s.total === 0) return null
  const last = s.recent[s.recent.length - 1]
  return t(lang, 'band.summary', { n: s.total, last: last ? lastHitText(lang, last) : '' })
}

/**
 * The band's "last" part, one short phrase: label, fingerprint, the tool and the file's
 * base name with its line (never the full path, which stays in /secret-guard), and the time.
 * `github token #ea21bbd9 · Read fp-test.env:2 · 23:11`
 */
export function lastHitText(lang: Lang, h: RecentHit): string {
  const head = h.fingerprint ? `${h.label} ${h.fingerprint}` : h.label
  let where: string
  if (h.tool && h.source) {
    const short = shortSource(h.tool, h.source)
    const isPath = !short.startsWith(`${h.tool} `) || !/\s/.test(short.slice(h.tool.length + 1))
    where = isPath && h.line !== undefined ? `${short}:${h.line}` : short
    if (h.agent) where += ` ${t(lang, 'cmd.hit.agent', { id: h.agent.slice(0, 8) })}`
  } else {
    where = whereText(lang, h.where, h.agent)
  }
  return [head, where, clockText(h.at)].join(' · ')
}

export type StatusState = BandState & { byLabel: Readonly<Record<string, number>>; scanToolResults: boolean; now: number; home?: string | null }

export function statusText(lang: Lang, s: StatusState): string {
  const lines: string[] = []
  lines.push(!s.enabled ? t(lang, 'cmd.status.disabled') : s.isPaused ? t(lang, 'cmd.status.paused') : t(lang, 'cmd.status.enabled'))
  lines.push(t(lang, 'cmd.status.scope', { scope: t(lang, s.scanToolResults ? 'cmd.scope.all' : 'cmd.scope.promptsOnly') }))
  if (s.badPatterns.length) lines.push(t(lang, 'cmd.status.badPatterns', { names: s.badPatterns.join(' | ') }))
  if (s.total === 0) {
    lines.push(t(lang, 'cmd.status.none'))
    return lines.join('\n')
  }
  lines.push(t(lang, 'cmd.status.total', { n: s.total }))
  lines.push(t(lang, 'cmd.status.byLabel'))
  for (const [label, n] of Object.entries(s.byLabel).sort((a, b) => b[1] - a[1])) lines.push(`  ${label}: ${n}`)
  lines.push(t(lang, 'cmd.status.recent'))
  for (const h of [...s.recent].slice(-STATUS_RECENT).reverse()) lines.push(`  ${hitLine(lang, h, s.home)}`)
  if (s.recent.length > STATUS_RECENT) lines.push(t(lang, 'cmd.status.more', { n: s.recent.length - STATUS_RECENT }))
  return lines.join('\n')
}

/** A sample of obviously fake values, one per detector family, for `/secret-guard test`. Built from pieces so no line looks like a credential. */
export function selfTestSample(): string {
  const rep = (ch: string, n: number) => ch.repeat(n)
  const lines = [
    `GOOGLE_API_KEY=AIza${rep('A', 35)}`,
    `access_token=ya29.${rep('a', 24)}`,
    `AWS_ACCESS_KEY_ID=AKIA${rep('Q', 16)}`,
    `aws_secret_access_key = ${rep('b', 40)}`,
    `ANTHROPIC_API_KEY=sk-ant-${rep('c', 24)}`,
    `OPENAI_API_KEY=sk-${rep('d', 24)}`,
    `GITHUB_TOKEN=ghp_${rep('e', 36)}`,
    `SLACK_TOKEN=xoxb-${rep('1', 12)}`,
    `Authorization: Bearer ${rep('f', 18)}42`,
    `postgres://app:${rep('g', 10)}42@db.internal/app`,
    `password = ${rep('h', 10)}1`,
    `-----BEGIN PRIVATE KEY-----\n${rep('i', 32)}\n-----END PRIVATE KEY-----`,
  ]
  return lines.join('\n')
}

export function selfTestText(lang: Lang, settings: Settings): string {
  const r = redact(selfTestSample(), settings)
  const lines = [t(lang, 'cmd.test.header')]
  for (const h of r.hits) lines.push(t(lang, 'cmd.test.fired', { label: h.label, n: h.count }))
  const left = (r.text.match(/<[a-z][a-z -]*(?: …[^>]{4})?>/g) ?? []).length
  lines.push(t(lang, 'cmd.test.summary', { n: r.hits.length, left }))
  return lines.join('\n')
}

/** Appends hit records to the session's recent list, newest last, keeping at most MAX_RECENT. */
export function pushRecent(recent: readonly RecentHit[], items: readonly RecentHit[]): RecentHit[] {
  return [...recent, ...items].slice(-MAX_RECENT)
}

export type ToolInfo = { tool: string; source?: string }

/**
 * The hit records for one redaction, values dropped: each found value with its
 * tool and source (looked up by tool_use_id, else the default source), its line
 * and its fingerprint (computed by the caller; undefined when off).
 */
export function hitRecords(
  found: readonly Found[],
  fingerprints: readonly (string | undefined)[],
  ctx: { where: string; agent: string | null; at: number; source?: string; lookup: (toolUseId: string) => ToolInfo | undefined },
): RecentHit[] {
  return found.map((f, i) => {
    const info = f.toolUseId !== undefined ? ctx.lookup(f.toolUseId) : undefined
    const rec: RecentHit = { label: f.label, where: ctx.where, agent: ctx.agent, at: ctx.at }
    if (info) {
      rec.tool = info.tool
      if (info.source) rec.source = info.source
    } else if (ctx.source) rec.source = ctx.source
    rec.line = f.line
    const fp = fingerprints[i]
    if (fp) rec.fingerprint = fp
    return rec
  })
}

export function addByLabel(byLabel: Readonly<Record<string, number>>, hits: readonly Hit[]): Record<string, number> {
  const out = { ...byLabel }
  for (const h of hits) out[h.label] = (out[h.label] ?? 0) + h.count
  return out
}


// ── Band framing ───────────────────────────────────────────────────────────

/** How the mod's line above the prompt is framed: a rounded box, a thin rule beneath, or bare text. */
export type BandStyle = 'box' | 'rule' | 'plain'

/** The `band_style` option; anything but `rule` or `plain` is the default box. */
export function parseBandStyle(v: unknown): BandStyle {
  return v === 'rule' || v === 'plain' ? v : 'box'
}
