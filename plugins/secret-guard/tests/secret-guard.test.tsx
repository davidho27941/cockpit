// secret-guard tests: `claude plugin test plugins/secret-guard`
//
// Every fixture is built from pieces (`'AIza' + 'A'.repeat(35)`) so no line of this
// file looks like a live credential. The test's hooks on `on` sit beneath the plugin
// and stand for the engine: the stores at the bottom of prompt.submit, session.append,
// prompt.context and prompt.attachment, the toast, the clock and the environment.

import { describe, expect, mock, test } from 'claude-code/testing'

import { DEFAULT_LANG, LANGS, MESSAGES, resolveLang, t } from '../hooks/i18n'
import {
  BUILTIN_ALLOW,
  SCAN_DOORS,
  bandText,
  entropy,
  hitLabels,
  isObviousPlaceholder,
  isPlaceholderValue,
  isScannedDoor,
  parseCustomPatterns,
  placeholder,
  planAppend,
  readSettings,
  redact,
  redactBlocks,
  selfTestSample,
  selfTestText,
  statusText,
  toastText,
} from '../hooks/logic'

const S = readSettings({})
const rep = (ch: string, n: number) => ch.repeat(n)

/** Redacts with the default settings and returns the text. */
const r = (text: string, settings = S) => redact(text, settings).text
/** The labels that fired, in order. */
const labels = (text: string, settings = S) => redact(text, settings).hits.map(h => h.label)

// Fixtures, each assembled so the source never contains a credential-shaped literal
const GOOGLE_KEY = 'AIza' + 'Sy' + rep('A', 33)
const YA29 = 'ya29.' + 'a0Af' + rep('x', 24)
const REFRESH = '1//0' + 'g' + rep('Y', 24)
const GOCSPX = 'GOCSPX-' + rep('Z', 24)
const AKIA = 'AKIA' + rep('Q', 16)
const AWS_SECRET = rep('wJalr', 8)
const ANTHROPIC = 'sk-ant-' + 'api03-' + rep('k', 24)
const OPENAI = 'sk-' + 'proj-' + rep('o', 24)
const OPENAI_PLAIN = 'sk-' + rep('p', 24)
const GHP = 'ghp_' + rep('g', 36)
const GH_PAT = 'github_pat_' + rep('h', 30)
const GLPAT = 'glpat-' + rep('l', 20)
const NPM = 'npm_' + rep('n', 36)
const PYPI = 'pypi-AgEIcHlwaS5vcmc' + rep('p', 24)
const HF = 'hf_' + rep('f', 30)
const SLACK = 'xoxb-' + rep('1', 12) + '-' + rep('a', 24)
const SLACK_HOOK = 'https://hooks.slack.com/services/T' + rep('0', 8) + '/B' + rep('0', 8) + '/' + rep('c', 24)
const TELEGRAM = rep('1', 9) + ':' + 'AA' + rep('t', 33)
const STRIPE = 'sk_live_' + rep('s', 24)
const SENDGRID = 'SG.' + rep('s', 22) + '.' + rep('g', 43)
const TWILIO = 'SK' + rep('a', 32)
const JWT = 'eyJ' + rep('h', 10) + '.eyJ' + rep('p', 10) + '.' + rep('s', 20)
const DISCORD = 'M' + rep('d', 23) + '.' + rep('e', 6) + '.' + rep('f', 27)
const PEM = '-----BEGIN PRIVATE KEY-----\n' + rep('M', 32) + '\n' + rep('N', 32) + '\n-----END PRIVATE KEY-----'
const PEM_ESCAPED = '-----BEGIN RSA PRIVATE KEY-----\\n' + rep('M', 32) + '\\n-----END RSA PRIVATE KEY-----\\n'
const CERT = '-----BEGIN CERTIFICATE-----\n' + rep('C', 32) + '\n-----END CERTIFICATE-----'
const SA_JSON = JSON.stringify({ type: 'service_account', project_id: 'demo', private_key_id: rep('a1', 20), private_key: PEM_ESCAPED, client_email: 'sa@demo.iam.gserviceaccount.com' })
const HIGH_ENTROPY = 'Qm9ic3RhcmtXYWxkZW4xMjM0NTY3ODkwQUJDREVGZ2hpams'

// ── Detectors ──────────────────────────────────────────────────────────────

describe('detectors', () => {
  test('google: api key, oauth access and refresh tokens, client secret', async () => {
    expect(r(`key=${GOOGLE_KEY}`)).toBe('key=<google api key>')
    expect(r(`curl -H "Authorization: Bearer ${YA29}"`)).toBe('curl -H "Authorization: Bearer <google oauth access token>"')
    expect(r(`refresh_token: ${REFRESH}`)).toBe('refresh_token: <google oauth refresh token>')
    expect(r(`client_secret=${GOCSPX}`)).toBe('client_secret=<google oauth client secret>')
    // too short, and embedded in a longer word, are not keys
    expect(r('AIza' + rep('A', 10))).toBe('AIza' + rep('A', 10))
    expect(r('x' + GOOGLE_KEY)).toBe('x' + GOOGLE_KEY)
  })

  test('gcp service account json: both key fields, client_email and project_id kept', async () => {
    const out = r(SA_JSON)
    expect(out).toContain('"private_key":"<gcp service account private key>"')
    expect(out).toContain('"private_key_id":"<gcp service account private key id>"')
    expect(out).toContain('"client_email":"sa@demo.iam.gserviceaccount.com"')
    expect(out).toContain('"project_id":"demo"')
    expect(out).not.toContain('BEGIN')
    expect(labels(SA_JSON).sort()).toEqual(['gcp service account private key', 'gcp service account private key id'])
    // the same key fields outside a service-account file: the PEM detector, no key-id guess
    const plain = JSON.stringify({ private_key_id: rep('a1', 20), private_key: PEM_ESCAPED })
    expect(labels(plain)).toEqual(['private key'])
    expect(r(plain)).toContain(rep('a1', 20))
  })

  test('pem private keys, real or escaped newlines; certificates are not secrets', async () => {
    expect(r(`id_rsa:\n${PEM}\n`)).toBe('id_rsa:\n<private key>\n')
    expect(r(PEM_ESCAPED)).toBe('<private key>')
    expect(r(CERT)).toBe(CERT)
  })

  test('aws: access key id, and the secret only next to its name', async () => {
    expect(r(`AWS_ACCESS_KEY_ID=${AKIA}`)).toBe('AWS_ACCESS_KEY_ID=<aws access key id>')
    expect(r(`aws_secret_access_key = ${AWS_SECRET}`)).toBe('aws_secret_access_key = <aws secret access key>')
    expect(r(`"secretAccessKey": "${AWS_SECRET}"`)).toBe('"secretAccessKey": "<aws secret access key>"')
    // a 40-char token with no aws name nearby is left alone (no secret-ish word for the backstop either)
    expect(r(`checksum ${AWS_SECRET}`)).toBe(`checksum ${AWS_SECRET}`)
    // the documentation example pair is allowlisted
    expect(r(`AWS_ACCESS_KEY_ID=${BUILTIN_ALLOW[0]}`)).toBe(`AWS_ACCESS_KEY_ID=${BUILTIN_ALLOW[0]}`)
    expect(r(`aws_secret_access_key=${BUILTIN_ALLOW[1]}`)).toBe(`aws_secret_access_key=${BUILTIN_ALLOW[1]}`)
  })

  test('model providers: anthropic before openai', async () => {
    expect(r(`ANTHROPIC_API_KEY=${ANTHROPIC}`)).toBe('ANTHROPIC_API_KEY=<anthropic api key>')
    expect(r(`OPENAI_API_KEY=${OPENAI}`)).toBe('OPENAI_API_KEY=<openai api key>')
    expect(r(`OPENAI_API_KEY=${OPENAI_PLAIN}`)).toBe('OPENAI_API_KEY=<openai api key>')
    expect(labels(ANTHROPIC)).toEqual(['anthropic api key'])
    expect(r('sk-short')).toBe('sk-short')
  })

  test('forges and registries: github, gitlab, npm, pypi, hugging face', async () => {
    expect(r(`token ${GHP}`)).toBe('token <github token>')
    expect(r(`token ${GH_PAT}`)).toBe('token <github token>')
    expect(r(`PRIVATE-TOKEN: ${GLPAT}`)).toBe('PRIVATE-TOKEN: <gitlab token>')
    expect(r(`//registry.npmjs.org/:_authToken=${NPM}`)).toBe('//registry.npmjs.org/:_authToken=<npm token>')
    expect(r(`password = ${PYPI}`)).toBe('password = <pypi token>')
    expect(r(`HF_TOKEN=${HF}`)).toBe('HF_TOKEN=<hugging face token>')
    expect(r('ghp_short')).toBe('ghp_short')
  })

  test('chat: slack token and webhook, telegram, discord', async () => {
    expect(r(`SLACK_BOT_TOKEN=${SLACK}`)).toBe('SLACK_BOT_TOKEN=<slack token>')
    expect(r(`curl -X POST ${SLACK_HOOK}`)).toBe('curl -X POST <slack webhook url>')
    expect(r(`bot: ${TELEGRAM}`)).toBe('bot: <telegram bot token>')
    expect(r(`DISCORD_TOKEN=${DISCORD}`)).toBe('DISCORD_TOKEN=<discord bot token>')
    expect(r('https://hooks.slack.com/')).toBe('https://hooks.slack.com/')
  })

  test('payments, mail, telephony: stripe, sendgrid, twilio', async () => {
    expect(r(`STRIPE_SECRET_KEY=${STRIPE}`)).toBe('STRIPE_SECRET_KEY=<stripe secret key>')
    expect(r(`SENDGRID_API_KEY=${SENDGRID}`)).toBe('SENDGRID_API_KEY=<sendgrid api key>')
    expect(r(`TWILIO_API_KEY=${TWILIO}`)).toBe('TWILIO_API_KEY=<twilio api key>')
    expect(r('pk_live_' + rep('s', 24))).toBe('pk_live_' + rep('s', 24)) // publishable keys are public
  })

  test('jwt wins over the discord shape; bearer, basic, api-key headers, url credentials', async () => {
    expect(r(`Authorization: Bearer ${JWT}`)).toBe('Authorization: Bearer <jwt>')
    expect(r(`token=${JWT}`)).toBe('token=<jwt>')
    expect(r(`Authorization: Bearer ${rep('b', 18)}42`)).toBe('Authorization: Bearer <bearer token>')
    expect(r(`authorization: basic ${rep('c', 14)}42`)).toBe('authorization: basic <basic auth>')
    expect(r(`Authorization: Token ${rep('d', 14)}42`)).toBe('Authorization: Token <token>')
    expect(r(`x-api-key: ${rep('e', 14)}42`)).toBe('x-api-key: <api key>')
    expect(r(`postgres://app:${rep('h', 10)}42@db.internal:5432/app`)).toBe('postgres://app:<password>@db.internal:5432/app')
    expect(r('Authorization: Bearer xxxxxxxxxx')).toBe('Authorization: Bearer xxxxxxxxxx')
    expect(r('https://example.com/path?x=1')).toBe('https://example.com/path?x=1')
    expect(r('Authorization: Bearer <token-from-env>')).toBe('Authorization: Bearer <token-from-env>')
    expect(r('Authorization: Bearer $TOKEN')).toBe('Authorization: Bearer $TOKEN')
  })

  test('generic assignments: real values go, placeholders, code and paths stay', async () => {
    expect(r(`password = ${rep('h', 10)}1`)).toBe('password = <secret value>')
    expect(r(`"api_key": "${rep('k', 12)}9"`)).toBe('"api_key": "<secret value>"')
    expect(r(`export SECRET=${rep('s', 8)}2`)).toBe('export SECRET=<secret value>')
    expect(r('db_password: p@ss' + rep('w', 8))).toBe('db_password: <secret value>')
    for (const left of [
      'password: <your-password>',
      'token = "xxx"',
      'token = ${TOKEN}',
      'secret = os.environ["X"]',
      'token = get_token()',
      'api_key = process.env.API_KEY',
      'password = changeme-now',
      'password = example-pass',
      'private_key = ./keys/id_rsa',
      'token: https://example.com/callback',
      'password = password_input',
      'secret = null',
      'pwd = /usr/local/bin',
      'token = true',
    ]) {
      expect(r(left)).toBe(left)
    }
  })

  test('negatives: hashes, uuids, data uris, emails and ordinary text are untouched', async () => {
    for (const text of [
      'commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
      'sha256:' + rep('ab', 32),
      'id: 123e4567-e89b-12d3-a456-426614174000',
      'data:image/png;base64,' + 'iVBORw0KGgo' + rep('A', 60) + '=',
      'mail me at dev@example.com',
      '/Users/me/.config/gcloud/credentials.db',
      'The quick brown fox jumps over the lazy dog',
      'version: 2.1.289',
    ]) {
      expect(r(text)).toBe(text)
    }
  })
})

// ── redact: idempotence, allowlists, custom rules, hints, entropy ───────────

describe('redact', () => {
  test('is idempotent: redacting the output changes nothing', async () => {
    const text = [`key=${GOOGLE_KEY}`, `AWS_ACCESS_KEY_ID=${AKIA}`, `Authorization: Bearer ${JWT}`, `password = ${rep('q', 12)}`, PEM, SA_JSON].join('\n')
    const once = redact(text, S)
    const twice = redact(once.text, S)
    expect(twice.text).toBe(once.text)
    expect(twice.hits).toEqual([])
    const hinted = readSettings({ keep_hint: true })
    const h1 = redact(text, hinted)
    expect(redact(h1.text, hinted).hits).toEqual([])
  })

  test('counts hits by label', async () => {
    const out = redact(`a=${GOOGLE_KEY} b=${GOOGLE_KEY} c=${GHP}`, S)
    expect(out.hits).toEqual([
      { label: 'google api key', count: 2 },
      { label: 'github token', count: 1 },
    ])
    expect(hitLabels(out.hits)).toBe('google api key ×2, github token')
  })

  test('allow_patterns leave a match alone', async () => {
    const settings = readSettings({ allow_patterns: '^AIzaSyA{33}$\nTESTONLY' })
    expect(r(`key=${GOOGLE_KEY}`, settings)).toBe(`key=${GOOGLE_KEY}`)
    expect(r(`key=${'AIza' + 'Sy' + rep('B', 33)}`, settings)).toBe('key=<google api key>')
    expect(r(`password = TESTONLY_${rep('x', 8)}`, settings)).toBe(`password = TESTONLY_${rep('x', 8)}`)
  })

  test('custom_patterns add detectors; invalid lines are reported, not applied', async () => {
    const parsed = parseCustomPatterns('acme token=ACME-[0-9]{8}\nbroken=(unclosed\nno-equals-here\n# a comment\n/slashed/i=/corp_[a-z]{6}/i')
    expect(parsed.rules.map(x => x.label)).toEqual(['acme token', '/slashed/i'])
    expect(parsed.bad).toEqual(['broken=(unclosed', 'no-equals-here'])
    const settings = readSettings({ custom_patterns: 'acme token=ACME-[0-9]{8}\nbroken=(unclosed' })
    expect(settings.badPatterns).toEqual(['broken=(unclosed'])
    expect(r('id ACME-12345678 and ACME-87654321', settings)).toBe('id <acme token> and <acme token>')
    expect(labels('ACME-12345678', settings)).toEqual(['acme token'])
  })

  test('keep_hint keeps the last four characters', async () => {
    const settings = readSettings({ keep_hint: true })
    expect(r(`key=${GOOGLE_KEY}`, settings)).toBe('key=<google api key …AAAA>')
    expect(placeholder('x', 'short', true)).toBe('<x>')
    expect(placeholder('x', rep('a', 7) + 'Zx3f', true)).toBe('<x …Zx3f>')
  })

  test('entropy backstop: only a random token next to a secret-ish name', async () => {
    expect(entropy('aaaa')).toBe(0)
    expect(entropy(HIGH_ENTROPY)).toBeGreaterThan(4)
    expect(r(`signing_key: ${HIGH_ENTROPY}`)).toBe('signing_key: <high-entropy secret>')
    expect(r(`SESSION_TOKEN_VALUE ${HIGH_ENTROPY}`)).toBe('SESSION_TOKEN_VALUE <high-entropy secret>')
    // no secret-ish name nearby: left alone
    expect(r(`blob ${HIGH_ENTROPY}`)).toBe(`blob ${HIGH_ENTROPY}`)
    // a hex hash next to a secret-ish name: not a secret shape
    expect(r(`token_hash: ${rep('ab', 32)}`)).toBe(`token_hash: ${rep('ab', 32)}`)
    // a uuid next to a secret-ish name
    expect(r('api_key_id: 123e4567-e89b-12d3-a456-426614174000')).toBe('api_key_id: 123e4567-e89b-12d3-a456-426614174000')
    // data uri payload after a secret-ish word
    expect(r(`token image data:image/png;base64,${HIGH_ENTROPY}`)).toBe(`token image data:image/png;base64,${HIGH_ENTROPY}`)
    const off = readSettings({ entropy_backstop: false })
    expect(r(`signing_key: ${HIGH_ENTROPY}`, off)).toBe(`signing_key: ${HIGH_ENTROPY}`)
    // regression: a NAME=value line is never swallowed as one token; a hex hash after a secret-ish name stays
    const sha = '3b2c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d'
    expect(r(`NOT_A_SECRET_SHA=${sha}`)).toBe(`NOT_A_SECRET_SHA=${sha}`)
    expect(r(`API_SECRET_BLOB=${HIGH_ENTROPY}`)).toBe('API_SECRET_BLOB=<high-entropy secret>')
  })

  test('isPlaceholderValue', async () => {
    for (const v of ['<x>', '${X}', '{{x}}', '$X', 'xxxxxxxx', '********', 'changeme', 'your-key-here', 'aaaaaaaaaa', 'os.environ', 'get()', './a/b', 'C:\\x\\y', 'https://x.y/z', 'passwordvalue']) {
      expect(isPlaceholderValue(v)).toBe(true)
    }
    for (const v of [rep('h', 10) + '1', 'p@ss' + rep('w', 8), 'https://u:p@h/x']) expect(isPlaceholderValue(v)).toBe(false)
    for (const v of ['<x>', '$X', 'xxxxxxxx', 'aaaaaaaaaa', 'your-key-here']) expect(isObviousPlaceholder(v)).toBe(true)
    for (const v of ['passwordvalue', 'os.environ', './a/b', rep('e', 14) + '42']) expect(isObviousPlaceholder(v)).toBe(false)
  })

  test('redactBlocks rewrites text and tool_result blocks and reports when nothing changed', async () => {
    const blocks = [
      { type: 'text', text: `key=${GOOGLE_KEY}` },
      { type: 'tool_result', tool_use_id: 't1', content: `export GITHUB_TOKEN=${GHP}` },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: `pwd: ${rep('z', 10)}1` }, { type: 'image', source: {} }] },
      { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: GOOGLE_KEY } },
      { type: 'thinking', thinking: GOOGLE_KEY },
    ]
    const out = redactBlocks(blocks, S)
    expect(out.changed).toBe(true)
    expect(out.blocks[0]).toEqual({ type: 'text', text: 'key=<google api key>' })
    expect(out.blocks[1]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'export GITHUB_TOKEN=<github token>' })
    expect((out.blocks[2] as unknown as { content: unknown[] }).content[0]).toEqual({ type: 'text', text: 'pwd: <secret value>' })
    expect(out.blocks[3]).toBe(blocks[3]) // tool_use is pinned: untouched, same object
    expect(out.blocks[4]).toBe(blocks[4])
    expect(out.hits.map(h => h.label).sort()).toEqual(['github token', 'google api key', 'secret value'])
    const clean = redactBlocks([{ type: 'text', text: 'hello' }], S)
    expect(clean.changed).toBe(false)
  })

  test('doors: the model response and notices are never scanned; scan_tool_results narrows to prompts', async () => {
    for (const d of SCAN_DOORS) expect(isScannedDoor(d, S)).toBe(true)
    expect(isScannedDoor('response', S)).toBe(false)
    expect(isScannedDoor('notice', S)).toBe(false)
    const narrow = readSettings({ scan_tool_results: false })
    expect(isScannedDoor('prompt', narrow)).toBe(true)
    expect(isScannedDoor('command', narrow)).toBe(true)
    expect(isScannedDoor('tool-result', narrow)).toBe(false)
    expect(isScannedDoor('attachment', narrow)).toBe(false)
  })

  test('the self-test sample fires one detector per family and ends with placeholders only', async () => {
    const out = redact(selfTestSample(), S)
    expect(out.hits.map(h => h.label).sort()).toEqual(
      [
        'anthropic api key',
        'aws access key id',
        'aws secret access key',
        'bearer token',
        'github token',
        'google api key',
        'google oauth access token',
        'openai api key',
        'password',
        'private key',
        'secret value',
        'slack token',
      ].sort(),
    )
    expect(redact(out.text, S).hits).toEqual([])
    expect(selfTestText('en', S)).toContain('12 detector(s) fired')
  })
})

// ── i18n and texts ─────────────────────────────────────────────────────────

describe('i18n', () => {
  test('resolveLang: option wins, then LC_ALL, LC_MESSAGES, LANG; zh* → zh-TW, ja* → ja, else en', async () => {
    expect(resolveLang('ja', { LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('zh-TW', {})).toBe('zh-TW')
    expect(resolveLang('en', { LANG: 'ja_JP.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LANG: 'zh_TW.UTF-8' })).toBe('zh-TW')
    expect(resolveLang('auto', { LANG: 'zh_CN.UTF-8' })).toBe('zh-TW')
    expect(resolveLang('auto', { LANG: 'ja_JP.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LC_ALL: 'C', LANG: 'ja_JP.UTF-8' })).toBe('en')
    expect(resolveLang('auto', { LC_MESSAGES: 'ja_JP', LANG: 'en_US' })).toBe('ja')
    expect(resolveLang(undefined, { LANG: 'en_US.UTF-8' })).toBe('en')
    expect(resolveLang(undefined, {})).toBe(DEFAULT_LANG)
    expect(resolveLang('fr', { LANG: 'fr_FR' })).toBe('en')
  })

  test('every key exists in every language; a missing key falls back to English', async () => {
    const keys = Object.keys(MESSAGES.en)
    for (const lang of LANGS) {
      for (const k of keys) expect(typeof (MESSAGES[lang] as Record<string, unknown>)[k]).not.toBe('undefined')
    }
    expect(t('ja', 'toast.redacted', { n: 2, labels: 'x' })).toBe('secret-guard：2 件を伏せました（x）')
    expect(t('zh-TW', 'band.paused')).toContain('已暫停')
  })

  test('toast, band and status texts', async () => {
    const hits = [{ label: 'google api key', count: 1 }]
    expect(toastText('en', hits, 'prompt', null)).toBe('secret-guard: redacted 1 (google api key)')
    expect(toastText('en', hits, 'tool-result', null)).toBe('secret-guard: redacted 1 (google api key) in tool result')
    expect(toastText('en', hits, 'tool-result', 'agent-123456789')).toBe('secret-guard: redacted 1 (google api key) in tool result, agent agent-12')
    const base = { enabled: true, isPaused: false, total: 0, recent: [], badPatterns: [] }
    expect(bandText('en', base)).toBe(null)
    expect(bandText('en', { ...base, isPaused: true })).toBe('🛡 secret-guard · paused (/secret-guard on resumes)')
    expect(bandText('en', { ...base, badPatterns: ['broken=(x'] })).toBe('🛡 secret-guard · 1 invalid custom pattern(s) ignored: broken')
    const recent = [{ label: 'google api key', where: 'tool-result', agent: null, at: 1000 }]
    expect(bandText('en', { ...base, total: 3, recent })).toBe('🛡 secret-guard · 3 redacted this session · last: google api key (tool result)')
    expect(bandText('en', { ...base, enabled: false, total: 3, recent })).toBe(null)
    const status = statusText('en', { ...base, total: 3, recent, byLabel: { 'google api key': 3 }, scanToolResults: true, now: 61_000 })
    expect(status).toContain('secret-guard: enabled')
    expect(status).toContain('redacted this session: 3')
    expect(status).toContain('  google api key: 3')
    expect(status).toContain('google api key · tool result · 1m ago')
    expect(statusText('en', { ...base, byLabel: {}, scanToolResults: false, now: 0 })).toContain('prompts and context only')
  })
})

// ── The session.append decision (pure; the hook only adds the `$` calls) ───

const row = (door: string, content: unknown, agentId?: string) => ({
  message: { type: 'user', role: 'user', content },
  door,
  origin: { kind: 'tool', tool: 'Read' },
  uuid: 'u1',
  ...(agentId ? { agentId } : {}),
})

describe('planAppend', () => {
  test('a tool result is rewritten before it is stored; the label is reported, never the value', async () => {
    const e = row('tool-result', [{ type: 'tool_result', tool_use_id: 't1', content: `GITHUB_TOKEN=${GHP}\nok` }])
    const plan = planAppend(e, S)
    expect(plan.kind).toBe('rewrite')
    if (plan.kind !== 'rewrite') return
    expect((plan.input.message.content as any[])[0].content).toBe('GITHUB_TOKEN=<github token>\nok')
    expect(JSON.stringify(plan.input)).not.toContain(GHP)
    expect(plan.input.uuid).toBe('u1')
    expect(plan.hits).toEqual([{ label: 'github token', count: 1 }])
    expect(plan.where).toBe('tool-result')
    expect(plan.agent).toBe(null)
  })

  test('the model response and notices pass through, as does a clean row', async () => {
    for (const door of ['response', 'notice']) expect(planAppend(row(door, [{ type: 'text', text: `echo ${GHP}` }]), S)).toEqual({ kind: 'pass' })
    expect(planAppend(row('prompt', [{ type: 'text', text: 'nothing here' }]), S)).toEqual({ kind: 'pass' })
  })

  test('an array tool_result and a subagent row', async () => {
    const e = row('tool-result', [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: `pwd=${rep('v', 10)}1` }, { type: 'image', source: {} }] }], 'agent-abcdef0123')
    const plan = planAppend(e, S)
    expect(plan.kind).toBe('rewrite')
    if (plan.kind !== 'rewrite') return
    const inner = (plan.input.message.content as any[])[0].content
    expect(inner[0]).toEqual({ type: 'text', text: 'pwd=<secret value>' })
    expect(inner[1]).toEqual({ type: 'image', source: {} })
    expect(plan.input.agentId).toBe('agent-abcdef0123')
    expect(plan.agent).toBe('agent-abcdef0123')
    expect(plan.where).toBe('tool-result')
  })

  test('scan_tool_results=false leaves tool results alone but still scans prompts', async () => {
    const narrow = readSettings({ scan_tool_results: false })
    expect(planAppend(row('tool-result', [{ type: 'tool_result', tool_use_id: 't1', content: `key=${GOOGLE_KEY}` }]), narrow)).toEqual({ kind: 'pass' })
    const plan = planAppend(row('prompt', [{ type: 'text', text: `key=${GOOGLE_KEY}` }]), narrow)
    expect(plan.kind).toBe('rewrite')
    if (plan.kind === 'rewrite') expect((plan.input.message.content as any[])[0].text).toBe('key=<google api key>')
  })

  test('a row without a content array passes through', async () => {
    expect(planAppend(row('tool-result', null), S)).toEqual({ kind: 'pass' })
    expect(planAppend(row('tool-result', 'text'), S)).toEqual({ kind: 'pass' })
  })
})

// ── Integration: the hooks over a mocked engine ────────────────────────────

type World = {
  clock: ReturnType<typeof mock.clock>
  toasts: string[]
  prompts: string[]
}

function world(on: any, env: Record<string, string> = { LANG: 'en_US.UTF-8' }): World {
  const w: World = { clock: mock.clock(on, { now: 1_000_000 }), toasts: [], prompts: [] }
  mock.env(on, env)
  const value = (v: unknown) => ({ value: v })
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(String(e.text ?? e))
    return value(undefined)
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">ENGINE_DEFAULT</Text>
  })
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // The stores beneath: what arrives here is what the model will read
  on('prompt.submit', (_$: any, e: any) => {
    w.prompts.push(String(e.text))
    return { text: e.text, origin: e.origin }
  })
  on('prompt.context', (_$: any, e: any) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  on('prompt.attachment', (_$: any, e: any) => ({ text: e.text }))
  return w
}

async function start($: any, w: World): Promise<void> {
  await $.session.start({ cwd: '/home/u/proj', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

async function command($: any, args = ''): Promise<string> {
  const out: any = await $.command.run({ command: 'secret-guard', args, origin: { kind: 'composer' } } as any)
  return String(out?.text ?? '')
}

const BAND = { plugin: 'secret-guard', component: 'AbovePrompt', props: {} } as const

async function bandTexts($: any, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...BAND, surface } as any)
  const found = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return found.map((x: any) => String(x.text ?? ''))
}

describe('secret-guard', () => {
  test('the prompt is redacted before it enters; a toast names the label, never the value', async ($, on) => {
    const w = world(on)
    await start($, w)
    const out: any = await $.prompt.submit({ text: `use key ${GOOGLE_KEY} please`, origin: { kind: 'composer' }, wait: false } as any)
    expect(out.text).toBe('use key <google api key> please')
    expect(w.prompts).toEqual(['use key <google api key> please'])
    expect(w.toasts).toEqual(['secret-guard: redacted 1 (google api key)'])
    expect(w.toasts.join(' ')).not.toContain(GOOGLE_KEY)
    // a clean prompt passes through, no toast
    await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false } as any)
    expect(w.prompts.at(-1)).toBe('hello')
    expect(w.toasts.length).toBe(1)
  })

  test('scan_tool_results=false: status says prompts and context only', { options: { scan_tool_results: false } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(await command($)).toContain('prompts and context only')
  })

  test('prompt.context blocks are rewritten; instructionFiles kept', async ($, on) => {
    const w = world(on)
    await start($, w)
    const out: any = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: `# notes\nSLACK_TOKEN=${SLACK}` }, { name: 'currentDate', text: '2026-10-05' }], instructionFiles: [] } as any)
    expect(out.blocks[0].text).toBe('# notes\nSLACK_TOKEN=<slack token>')
    expect(out.blocks[1].text).toBe('2026-10-05')
    // the engine forgets the files behind a rewritten claudeMd text (its documented rule), so none are claimed
    expect(out.instructionFiles).toBe(undefined)
    expect(w.toasts.at(-1)).toBe('secret-guard: redacted 1 (slack token) in context')
  })

  test('prompt.attachment text is rewritten', async ($, on) => {
    const w = world(on)
    await start($, w)
    const out: any = await $.prompt.attachment({ type: 'file', text: `.env:\nSTRIPE_SECRET_KEY=${STRIPE}`, origin: { kind: 'engine' } } as any)
    expect(out.text).toBe('.env:\nSTRIPE_SECRET_KEY=<stripe secret key>')
    expect(w.toasts.at(-1)).toBe('secret-guard: redacted 1 (stripe secret key) in attachment')
  })

  test('/secret-guard off pauses, on resumes; status and test', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(await command($)).toContain('nothing redacted yet')
    expect(await command($, 'off')).toContain('paused')
    const paused: any = await $.prompt.submit({ text: `key ${GOOGLE_KEY}`, origin: { kind: 'composer' }, wait: false } as any)
    expect(paused.text).toBe(`key ${GOOGLE_KEY}`)
    expect(await bandTexts($)).toContain('🛡 secret-guard · paused (/secret-guard on resumes)')
    expect(await command($, 'on')).toContain('resumed')
    const live: any = await $.prompt.submit({ text: `key ${GOOGLE_KEY}`, origin: { kind: 'composer' }, wait: false } as any)
    expect(live.text).toBe('key <google api key>')
    const status = await command($)
    expect(status).toContain('redacted this session: 1')
    expect(status).toContain('google api key · prompt')
    const selfTest = await command($, 'test')
    expect(selfTest).toContain('12 detector(s) fired')
    expect(selfTest).not.toContain('AIza')
    expect(await command($, 'bogus')).toContain('Usage')
  })

  test('band: hidden until something was redacted, then the count and the last label; stacks above the engine', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(await bandTexts($)).toEqual(['ENGINE_DEFAULT'])
    await $.prompt.submit({ text: `a=${AKIA}`, origin: { kind: 'composer' }, wait: false } as any)
    for (const surface of ['terminal', 'desktop'] as const) {
      const texts = await bandTexts($, surface)
      expect(texts[0]).toBe('🛡 secret-guard · 1 redacted this session · last: aws access key id (prompt)')
      expect(texts).toContain('ENGINE_DEFAULT')
    }
  })

  test('language=ja: toast, band and command in Japanese', { options: { language: 'ja' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.prompt.submit({ text: `key ${GOOGLE_KEY}`, origin: { kind: 'composer' }, wait: false } as any)
    expect(w.toasts.at(-1)).toBe('secret-guard：1 件を伏せました（google api key）')
    expect((await bandTexts($))[0]).toBe('🛡 secret-guard · このセッションで 1 件伏せました · 直近：google api key（プロンプト）')
    expect(await command($, 'off')).toContain('一時停止')
  })

  test('language=auto with LANG=zh_TW.UTF-8: Traditional Chinese', async ($, on) => {
    const w = world(on, { LANG: 'zh_TW.UTF-8' })
    await start($, w)
    await $.prompt.submit({ text: `t=${GHP}`, origin: { kind: 'composer' }, wait: false } as any)
    expect(w.toasts.at(-1)).toBe('secret-guard：已遮蔽 1 處（github token）')
    expect(await command($)).toContain('本 session 已遮蔽：1 處')
  })

  test('enabled=false: nothing is scanned and the band stays empty', { options: { enabled: false } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    const out: any = await $.prompt.submit({ text: `key ${GOOGLE_KEY}`, origin: { kind: 'composer' }, wait: false } as any)
    expect(out.text).toBe(`key ${GOOGLE_KEY}`)
    expect(w.toasts).toEqual([])
    expect(await bandTexts($)).toEqual(['ENGINE_DEFAULT'])
    expect(await command($)).toContain('disabled in settings')
  })

  test('invalid custom patterns show once in the band and in the status', { options: { custom_patterns: 'acme=ACME-[0-9]{4}\nbroken=(x' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    expect((await bandTexts($))[0]).toBe('🛡 secret-guard · 1 invalid custom pattern(s) ignored: broken')
    expect(await command($)).toContain('invalid custom patterns ignored: broken=(x')
    const out: any = await $.prompt.submit({ text: 'see ACME-1234', origin: { kind: 'composer' }, wait: false } as any)
    expect(out.text).toBe('see <acme>')
  })

  // The band's frame: a rounded box, dim normally and yellow while paused or when a custom pattern is invalid.
  const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l))
  async function frames($: any): Promise<{ boxes: any[]; texts: string[] }> {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    const boxes = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.borderStyle === 'round')
    const found = await ui.findAll({ type: 'Text' })
    await ui.unmount()
    return { boxes, texts: found.map((x: any) => String(x.text ?? '')) }
  }

  test('band_style=box (default): dim frame after a redaction, yellow while paused, no rule', async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.prompt.submit({ text: `a=${AKIA}`, origin: { kind: 'composer' }, wait: false } as any)
    let f = await frames($)
    expect(f.boxes.length).toBe(1)
    expect(f.boxes[0]?.props?.borderDimColor).toBe(true)
    expect(f.boxes[0]?.props?.borderColor).toBe(undefined)
    expect(has(f.texts, /^─+$/)).toBe(false)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
    await command($, 'off')
    f = await frames($)
    expect(f.boxes[0]?.props?.borderColor).toBe('yellow')
    expect(f.boxes[0]?.props?.borderDimColor).toBe(undefined)
  })

  test('band_style=rule draws the thin line beneath when a plugin is below', { options: { band_style: 'rule' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.prompt.submit({ text: `a=${AKIA}`, origin: { kind: 'composer' }, wait: false } as any)
    const f = await frames($)
    expect(f.boxes.length).toBe(0)
    expect(has(f.texts, /^─+$/)).toBe(true)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
  })

  test('band_style=plain draws neither frame nor rule', { options: { band_style: 'plain' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    await $.prompt.submit({ text: `a=${AKIA}`, origin: { kind: 'composer' }, wait: false } as any)
    const f = await frames($)
    expect(f.boxes.length).toBe(0)
    expect(has(f.texts, /^─+$/)).toBe(false)
    expect(has(f.texts, /🛡 secret-guard · 1 redacted/)).toBe(true)
    expect(has(f.texts, /ENGINE_DEFAULT/)).toBe(true)
  })
})
