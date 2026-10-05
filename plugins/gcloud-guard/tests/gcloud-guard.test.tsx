// gcloud-guard tests: `claude plugin test plugins/gcloud-guard`
//
// The test's hooks on `on` sit beneath the plugin and stand for the engine: the
// process runner (gcloud answers from a table, `sleep` waits on the mocked clock),
// the pane, the toast, and the Bash tool itself.

import { describe, expect, mock, test } from 'claude-code/testing'

import { DEFAULT_LANG, DENY_TAIL, LANGS, MESSAGES, resolveLang, t } from '../hooks/i18n'
import {
  CONTEXT_TICK_MS,
  HOLD_LIMIT_MS,
  buildContext,
  classify,
  contextLine,
  contextText,
  countObjects,
  currentContextOf,
  denyText,
  describeArgv,
  headline,
  isHeld,
  isRsyncDelete,
  keyFlagsLine,
  listObjectsArgv,
  parseGcloudArgs,
  parseGcloudIni,
  parseKubeContext,
  readSettings,
  splitKubeconfigList,
  splitSegments,
  stripWrappers,
  summarizeDescribe,
  tokenize,
  touchesContext,
} from '../hooks/logic'
import type { Risk } from '../types'

const S = readSettings({})
const c = (command: string, settings = S): Risk | null => classify(command, settings)

// ── Pure: tokenizer and wrappers ───────────────────────────────────────────

describe('tokenizer', () => {
  test('quotes are honoured, segments split on the shell operators', async () => {
    expect(tokenize(`gcloud compute instances create "my vm" '--labels=a=b'`)).toEqual(['gcloud', 'compute', 'instances', 'create', 'my vm', '--labels=a=b'])
    expect(splitSegments('echo hi && gcloud projects list | grep x; ls')).toEqual(['echo hi', 'gcloud projects list', 'grep x', 'ls'])
    expect(stripWrappers(['FOO=1', 'sudo', '-u', 'ops', 'env', 'gcloud', 'x'])).toEqual(['gcloud', 'x'])
    expect(stripWrappers(['(cd', 'a', '&&', 'gcloud)'])).toEqual(['cd', 'a', '&&', 'gcloud'])
    expect(stripWrappers(['nice', '-n', '5', 'gcloud'])).toEqual(['gcloud'])
  })

  test('parseGcloudArgs reads the track, the path, the verb, the targets and the flags', async () => {
    const p = parseGcloudArgs(['beta', 'compute', 'instances', 'delete', 'a', 'b', '--zone', 'z1', '--project=p1', '-q', '--delete-disks=all'])
    expect(p.track).toBe('beta')
    expect(p.path).toEqual(['compute', 'instances'])
    expect(p.verb).toBe('delete')
    expect(p.targets).toEqual(['a', 'b'])
    expect(p.flags).toEqual({ quiet: true, zone: 'z1', project: 'p1' })
    expect(p.extra['delete-disks']).toBe('all')
    // A global flag before the path still counts; a bool flag never swallows the next word
    const q = parseGcloudArgs(['--project', 'p2', 'run', 'services', 'update-traffic', 'api', '--to-latest'])
    expect(q.flags.project).toBe('p2')
    expect(q.verb).toBe('update-traffic')
    expect(q.targets).toEqual(['api'])
  })
})

// ── Pure: the classifier table ─────────────────────────────────────────────

describe('classify', () => {
  test('delete-class gcloud commands are destructive', async () => {
    const r = c('gcloud compute instances delete web-1 --zone us-central1-a')
    expect(r?.severity).toBe('destructive')
    expect(r?.path).toEqual(['compute', 'instances'])
    expect(r?.targets).toEqual(['web-1'])
    expect(r?.flags.zone).toBe('us-central1-a')
    expect(c('gcloud compute instances delete web-1 web-2 --zone=z --quiet')?.targets).toEqual(['web-1', 'web-2'])
    expect(c('gcloud compute instances delete web-1 --zone=z --quiet')?.flags.quiet).toBe(true)
    expect(c('gcloud compute instances delete web-1 -q')?.flags.quiet).toBe(true)
    expect(c('gcloud sql instances delete db')?.severity).toBe('destructive')
    expect(c('gcloud iam service-accounts delete sa@p.iam.gserviceaccount.com')?.severity).toBe('destructive')
    expect(c('gcloud compute instances remove-tags web-1 --tags http')?.severity).toBe('destructive')
    expect(c('gcloud storage buckets delete gs://b')?.severity).toBe('destructive')
    expect(c('gcloud storage buckets delete gs://b')?.path).toEqual(['storage', 'buckets'])
  })

  test('update-class gcloud commands are mutating', async () => {
    expect(c('gcloud compute instances stop web-1')?.severity).toBe('mutating')
    expect(c('gcloud compute instances add-tags web-1 --tags http')?.severity).toBe('mutating')
    expect(c('gcloud sql instances patch db --tier=db-f1-micro')?.severity).toBe('mutating')
    expect(c('gcloud services enable compute.googleapis.com')?.severity).toBe('mutating')
    expect(c('gcloud services enable compute.googleapis.com')?.targets).toEqual(['compute.googleapis.com'])
    const resize = c('gcloud container clusters resize c1 --num-nodes 3 --region r')
    expect(resize?.severity).toBe('mutating')
    expect(resize?.targets).toEqual(['c1'])
    expect(c('gcloud run services update-traffic api --to-latest')?.severity).toBe('mutating')
    expect(c('gcloud scheduler jobs run j --location l')?.severity).toBe('mutating')
    expect(c('gcloud alpha run jobs execute j --region r')?.track).toBe('alpha')
    expect(c('gcloud compute instances delete web-1 --delete-disks=all')?.targets).toEqual(['web-1'])
  })

  test('deploy, build and IAM get their own kinds', async () => {
    const deploy = c('gcloud run deploy api --image gcr.io/p/i --region r')
    expect(deploy?.kind).toBe('deploy')
    expect(deploy?.severity).toBe('mutating')
    expect(deploy?.targets).toEqual(['api'])
    expect(c('gcloud functions deploy f --runtime nodejs20 --trigger-http')?.kind).toBe('deploy')
    expect(c('gcloud app deploy')?.kind).toBe('deploy')
    const build = c('gcloud builds submit --tag gcr.io/p/i .')
    expect(build?.kind).toBe('build')
    expect(build?.targets).toEqual(['.'])
    const add = c('gcloud projects add-iam-policy-binding my-proj --member=user:a@b.c --role=roles/owner')
    expect(add?.kind).toBe('iam')
    expect(add?.severity).toBe('mutating')
    expect(add?.extra.member).toBe('user:a@b.c')
    expect(add?.extra.role).toBe('roles/owner')
    const rm = c('gcloud projects remove-iam-policy-binding my-proj --member user:a@b.c --role roles/owner')
    expect(rm?.kind).toBe('iam')
    expect(rm?.severity).toBe('destructive')
    expect(c('gcloud projects set-iam-policy my-proj policy.json')?.targets).toEqual(['my-proj', 'policy.json'])
  })

  test('create-class gcloud commands are create', async () => {
    const r = c('gcloud compute instances create web-3 --machine-type e2-small --zone z')
    expect(r?.severity).toBe('create')
    expect(r?.targets).toEqual(['web-3'])
    expect(r?.extra['machine-type']).toBe('e2-small')
    expect(keyFlagsLine(r as Risk)).toBe('--machine-type=e2-small')
    expect(c('gcloud compute disks snapshot d1 --snapshot-names s1')?.severity).toBe('create')
    expect(c('gcloud iam service-accounts keys create k.json --iam-account sa@p.iam')?.path).toEqual(['iam', 'service-accounts', 'keys'])
    expect(c('gcloud deploy releases create r1 --delivery-pipeline p --region r')?.severity).toBe('create')
    expect(c('gcloud pubsub topics publish t --message hi')?.severity).toBe('create')
  })

  test('whole projects, organizations and folders carry a scope', async () => {
    expect(c('gcloud projects delete my-proj')?.scope).toBe('project')
    expect(c('gcloud projects delete my-proj')?.severity).toBe('destructive')
    expect(c('gcloud organizations delete 123')?.scope).toBe('org')
    expect(c('gcloud folders delete 456')?.scope).toBe('folder')
    expect(c('gcloud projects add-iam-policy-binding p --member m --role r')?.scope).toBe(undefined)
  })

  test('read-only verbs and local commands are never held', async () => {
    for (const cmd of [
      'gcloud compute instances describe web-1',
      'gcloud compute instances list --project foo',
      'gcloud container clusters get-credentials c1 --region r',
      'gcloud projects get-iam-policy my-proj',
      'gcloud projects describe my-proj',
      'gcloud services list --enabled',
      'gcloud storage ls gs://b',
      'gcloud config get-value project',
      'gcloud config list',
      'gcloud auth login',
      'gcloud auth revoke',
      'gcloud auth print-access-token',
      'gcloud components update',
      'gcloud compute ssh web-1 --zone z',
      'gcloud compute scp a.txt web-1:/tmp --zone z',
      'gcloud logging read "severity>=ERROR" --limit 10',
      'gcloud secrets versions access latest --secret s',
      'gcloud compute instances',
      'gcloud version',
      'gcloud help compute',
      'kubectl delete pod x',
      'terraform destroy',
      'echo gcloud compute instances delete web-1',
      'gcloud projects list | grep foo',
    ]) {
      expect(c(cmd)).toBe(null)
    }
  })

  test('the gcloud segment is found behind cd, sudo, env and other segments', async () => {
    expect(c('cd infra && gcloud compute instances delete web-1')?.severity).toBe('destructive')
    expect(c('sudo -u ops gcloud compute instances delete web-1')?.severity).toBe('destructive')
    expect(c('FOO=1 gcloud beta compute instances delete web-1')?.track).toBe('beta')
    expect(c('echo hi && gcloud compute instances delete web-1 --project=p')?.flags.project).toBe('p')
    expect(c('gcloud --project p compute instances delete web-1')?.flags.project).toBe('p')
    expect(c('/opt/google-cloud-sdk/bin/gcloud compute instances delete web-1')?.severity).toBe('destructive')
    expect(c('gcloud compute instances list && gcloud compute instances delete web-1')?.severity).toBe('destructive')
  })

  test('an unknown action verb under a known group is held to be safe', async () => {
    const r = c('gcloud compute instances perform-rollout web-1 --zone z')
    expect(r?.severity).toBe('mutating')
    expect(r?.unknownVerb).toBe(true)
    expect(r?.verb).toBe('perform-rollout')
    expect(r?.targets).toEqual(['web-1'])
    expect(c('gcloud compute instances frobnicate web-1')).toBe(null)
    expect(c('gcloud nonsense-group things perform-rollout x')).toBe(null)
  })

  test('gcloud config set is held as a local-config change; other config commands are not', async () => {
    const r = c('gcloud config set project foo')
    expect(r?.kind).toBe('local-config')
    expect(r?.severity).toBe('mutating')
    expect(r?.targets).toEqual(['project', 'foo'])
    expect(c('gcloud config configurations activate prod')?.kind).toBe('local-config')
    expect(c('gcloud config unset project')?.kind).toBe('local-config')
    expect(c('gcloud config configurations list')).toBe(null)
    expect(isHeld(r as Risk, readSettings({ hold_config_set: false }))).toBe(false)
    expect(isHeld(r as Risk, S)).toBe(true)
  })

  test('gcloud storage and gsutil', async () => {
    const rm = c('gcloud storage rm -r gs://b/dir')
    expect(rm?.severity).toBe('destructive')
    expect(rm?.kind).toBe('storage')
    expect(rm?.targets).toEqual(['gs://b/dir'])
    expect(c('gcloud storage cp a.txt gs://b/')?.severity).toBe('mutating')
    const rsync = c('gcloud storage rsync -r --delete-unmatched-destination-objects ./out gs://b/out')
    expect(rsync?.severity).toBe('mutating')
    expect(isRsyncDelete(rsync as Risk)).toBe(true)
    expect(isRsyncDelete(c('gcloud storage rsync -r ./out gs://b/out') as Risk)).toBe(false)
    const grm = c('gsutil rm -r gs://b/**')
    expect(grm?.tool).toBe('gsutil')
    expect(grm?.severity).toBe('destructive')
    expect(grm?.targets).toEqual(['gs://b/**'])
    expect(c('gsutil ls gs://b')).toBe(null)
    expect(c('gsutil -m cp -r dist gs://b')?.severity).toBe('mutating')
    expect(c('gsutil -u other-proj rm gs://b/x')?.flags.project).toBe('other-proj')
    const ch = c('gsutil iam ch user:a@b.c:objectViewer gs://b')
    expect(ch?.kind).toBe('iam')
    expect(ch?.verb).toBe('ch')
    expect(ch?.targets).toEqual(['user:a@b.c:objectViewer', 'gs://b'])
    expect(c('gsutil iam get gs://b')).toBe(null)
    expect(c('gsutil mb gs://new')?.severity).toBe('create')
    expect(c('gsutil rsync -d src gs://b')?.severity).toBe('mutating')
    expect(isRsyncDelete(c('gsutil rsync -d src gs://b') as Risk)).toBe(true)
    expect(c('gsutil rm -r gs://b/**', readSettings({ include_gsutil: false }))).toBe(null)
    expect(listObjectsArgv(grm as Risk, 'gs://b/**')).toEqual(['gsutil', 'ls', '-r', 'gs://b/**'])
    expect(listObjectsArgv(rm as Risk, 'gs://b/dir')).toEqual(['gcloud', 'storage', 'ls', '-r', 'gs://b/dir'])
  })

  test('the hold level filters by severity', async () => {
    const del = c('gcloud compute instances delete web-1') as Risk
    const upd = c('gcloud compute instances stop web-1') as Risk
    const cre = c('gcloud compute instances create web-1') as Risk
    expect([del, upd, cre].map(r => isHeld(r, readSettings({ hold: 'all' })))).toEqual([true, true, true])
    expect([del, upd, cre].map(r => isHeld(r, readSettings({ hold: 'mutating' })))).toEqual([true, true, false])
    expect([del, upd, cre].map(r => isHeld(r, readSettings({ hold: 'destructive' })))).toEqual([true, false, false])
  })
})

// ── Pure: lookups and text ─────────────────────────────────────────────────

describe('lookups and text', () => {
  test('describeArgv keeps the track, the path and the scope flags', async () => {
    const r = c('gcloud beta compute instances delete web-1 --zone z --project p --impersonate-service-account sa@p.iam') as Risk
    expect(describeArgv(r, 'web-1')).toEqual(['gcloud', 'beta', 'compute', 'instances', 'describe', 'web-1', '--format=json', '--zone=z', '--project=p', '--impersonate-service-account=sa@p.iam'])
  })

  test('summarizeDescribe reads the common fields and flags deletion protection', async () => {
    const vm = summarizeDescribe('en', 'web-1', {
      name: 'web-1', status: 'RUNNING', zone: 'https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a',
      machineType: '.../machineTypes/e2-small', creationTimestamp: '2026-09-01T10:00:00.000-07:00', labels: { a: '1', b: '2' },
      disks: [{ autoDelete: true }, { autoDelete: false }], deletionProtection: true,
    })
    expect(vm.line).toBe('web-1 · RUNNING · us-central1-a · e2-small · created 2026-09-01 · 2 labels · 2 disks (1 auto-delete)')
    expect(vm.notes).toEqual(['web-1: deletion protection is on; a delete fails unless it is turned off first'])
    const sql = summarizeDescribe('ja', 'db', { name: 'db', state: 'RUNNABLE', region: 'asia-east1', databaseVersion: 'POSTGRES_15', settings: { tier: 'db-custom-2-8192', deletionProtectionEnabled: true } })
    expect(sql.line).toBe('db · RUNNABLE · asia-east1 · POSTGRES_15 db-custom-2-8192')
    expect(sql.notes.length).toBe(1)
    const gke = summarizeDescribe('en', 'c1', { name: 'c1', status: 'RUNNING', location: 'us-central1', currentNodeCount: 3, createTime: '2026-01-02T00:00:00Z' })
    expect(gke.line).toBe('c1 · RUNNING · us-central1 · 3 nodes · created 2026-01-02')
    expect(summarizeDescribe('en', 'x', null).line).toBe('x')
  })

  test('countObjects counts object URLs and caps the listing', async () => {
    expect(countObjects('gs://b/dir/:\ngs://b/dir/a.txt\ngs://b/dir/b.txt\ngs://b/dir/sub/\n')).toEqual({ n: 2, cut: false })
    const many = Array.from({ length: 2500 }, (_, i) => `gs://b/o${i}`).join('\n')
    expect(countObjects(many)).toEqual({ n: 2000, cut: true })
  })

  test('headlines per kind and language', async () => {
    expect(headline('en', c('gcloud compute instances delete web-1 web-2') as Risk)).toBe('delete compute instances web-1, web-2')
    expect(headline('en', c('gcloud projects delete my-proj') as Risk)).toBe('shut down project my-proj (30-day recovery window)')
    expect(headline('zh-TW', c('gcloud projects delete my-proj') as Risk)).toBe('關閉專案 my-proj（30 天內可復原）')
    expect(headline('ja', c('gcloud config set project foo') as Risk, 'bar')).toBe('gcloud 設定 project を foo に切り替え（現在：bar）')
    expect(headline('en', c('gcloud run deploy api --region r') as Risk)).toBe('deploy run api (creates or replaces the revision)')
    expect(headline('en', c('gcloud projects add-iam-policy-binding p --member=user:a@b.c --role=roles/owner') as Risk)).toBe('grant roles/owner to user:a@b.c on projects p')
    expect(headline('en', c('gsutil rm -r gs://b/**') as Risk)).toBe('delete gs://b/**')
    expect(headline('en', c('gcloud storage cp a gs://b/') as Risk)).toBe('cp a, gs://b/')
  })

  test('every refusal carries the English tail', async () => {
    for (const lang of LANGS) {
      const d = denyText(lang, 'cancel', 'delete x', 'p')
      expect(d).toContain(DENY_TAIL)
      expect(d).toContain('delete x')
    }
    expect(denyText('en', 'timeout', 'delete x', null)).toContain('no answer within 10 minutes')
  })
})

describe('context files', () => {
  test('parseGcloudIni reads sections, skips comments, keys are section/key', async () => {
    const ini = parseGcloudIni('# gcloud config\n[core]\naccount = a@b.c\nproject=demo\n; comment\n\n[compute]\nzone = us-central1-a\nbare_key = 1\n[container]\ncluster = c1\n')
    expect(ini).toEqual({ 'core/account': 'a@b.c', 'core/project': 'demo', 'compute/zone': 'us-central1-a', 'compute/bare_key': '1', 'container/cluster': 'c1' })
    expect(parseGcloudIni('')).toEqual({})
  })

  test('parseKubeContext: GKE names split into project, location and cluster; others stay other', async () => {
    expect(parseKubeContext('gke_side-project-staging_us-central1_my-cluster')).toEqual({ kind: 'gke', name: 'gke_side-project-staging_us-central1_my-cluster', project: 'side-project-staging', location: 'us-central1', cluster: 'my-cluster' })
    expect(parseKubeContext('gke_p_us-central1-a_zonal')).toEqual({ kind: 'gke', name: 'gke_p_us-central1-a_zonal', project: 'p', location: 'us-central1-a', cluster: 'zonal' })
    expect(parseKubeContext('docker-desktop')).toEqual({ kind: 'other', name: 'docker-desktop' })
    expect(parseKubeContext('arn:aws:eks:us-east-1:123:cluster/my_cluster_x')).toEqual({ kind: 'other', name: 'arn:aws:eks:us-east-1:123:cluster/my_cluster_x' })
    expect(parseKubeContext('gke_only-two')).toEqual({ kind: 'other', name: 'gke_only-two' })
    expect(currentContextOf('kind: Config\ncurrent-context: "docker-desktop"\nusers: []\n')).toBe('docker-desktop')
    expect(currentContextOf('kind: Config\n')).toBe(null)
  })

  test('env overrides win over the files; KUBECONFIG lists files', async () => {
    const env = { HOME: '/home/u', CLOUDSDK_CORE_PROJECT: 'from-env', CLOUDSDK_ACTIVE_CONFIG_NAME: 'prod' }
    const ctx = buildContext({ env, configDir: '/home/u/.config/gcloud', activeConfigText: 'default\n', configText: '[core]\nproject = from-file\naccount = a@b.c\n', kubeconfigPath: null, kubeconfigText: null, now: 5 })
    expect(ctx.project).toBe('from-env')
    expect(ctx.projectSource).toBe('env')
    expect(ctx.configuration).toBe('prod')
    expect(ctx.account).toBe('a@b.c')
    expect(ctx.kube).toBe(null)
    const fromFile = buildContext({ env: { HOME: '/home/u' }, configDir: '/home/u/.config/gcloud', activeConfigText: null, configText: '[core]\nproject = p\n', kubeconfigPath: null, kubeconfigText: null, now: 5 })
    expect(fromFile.configuration).toBe('default')
    expect(fromFile.projectSource).toBe('file')
    expect(splitKubeconfigList('/a/one:/b/two', '/home/u')).toEqual(['/a/one', '/b/two'])
    expect(splitKubeconfigList(undefined, '/home/u')).toEqual(['/home/u/.kube/config'])
    expect(splitKubeconfigList('', null)).toEqual([])
  })

  test('contextLine in three languages, hidden when nothing is known, other contexts only on request', async () => {
    const env = { HOME: '/home/u' }
    const full = buildContext({ env, configDir: '/home/u/.config/gcloud', activeConfigText: 'default', configText: '[core]\nproject = side-project-staging\naccount = dev@example.com\n', kubeconfigPath: '/home/u/.kube/config', kubeconfigText: 'current-context: gke_side-project-staging_us-central1_my-cluster\n', now: 1 })
    expect(contextLine('en', full, S)).toBe('☁ gcloud · project side-project-staging · account dev@example.com · config default · GKE my-cluster (us-central1)')
    expect(contextLine('zh-TW', full, S)).toBe('☁ gcloud · 專案 side-project-staging · 帳號 dev@example.com · 設定檔 default · GKE my-cluster（us-central1）')
    expect(contextLine('ja', full, S)).toBe('☁ gcloud · プロジェクト side-project-staging · アカウント dev@example.com · 構成 default · GKE my-cluster（us-central1）')
    const fromEnv = buildContext({ env: { ...env, CLOUDSDK_CORE_PROJECT: 'p-env' }, configDir: '/home/u/.config/gcloud', activeConfigText: null, configText: null, kubeconfigPath: null, kubeconfigText: null, now: 1 })
    expect(contextLine('en', fromEnv, S)).toBe('☁ gcloud · project p-env ← CLOUDSDK_CORE_PROJECT · config default')
    const other = buildContext({ env, configDir: '/home/u/.config/gcloud', activeConfigText: null, configText: '[core]\nproject = p\n', kubeconfigPath: '/k', kubeconfigText: 'current-context: docker-desktop\n', now: 1 })
    expect(contextLine('en', other, S)).toBe('☁ gcloud · project p · config default')
    expect(contextLine('en', other, readSettings({ show_other_contexts: true }))).toBe('☁ gcloud · project p · config default · k8s docker-desktop')
    const nothing = buildContext({ env, configDir: '/home/u/.config/gcloud', activeConfigText: null, configText: null, kubeconfigPath: null, kubeconfigText: null, now: 1 })
    expect(contextLine('en', nothing, S)).toBe(null)
    expect(contextLine('en', null, S)).toBe(null)
    expect(contextText('en', full, S)).toContain('GKE             project side-project-staging · location us-central1 · cluster my-cluster')
    expect(contextText('en', null, S)).toContain('no gcloud configuration found')
  })

  test('touchesContext spots config, auth and kube context switches', async () => {
    expect(touchesContext('gcloud config set project x')).toBe(true)
    expect(touchesContext('gcloud auth login')).toBe(true)
    expect(touchesContext('gcloud container clusters get-credentials c --region r')).toBe(true)
    expect(touchesContext('kubectl config use-context dev')).toBe(true)
    expect(touchesContext('kubectx prod')).toBe(true)
    expect(touchesContext('gcloud compute instances list')).toBe(false)
    expect(touchesContext('kubectl get pods')).toBe(false)
  })
})

describe('i18n', () => {
  test('resolveLang: option wins, then LC_ALL, LC_MESSAGES, LANG; C and POSIX are English', async () => {
    expect(resolveLang('ja', { LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LC_ALL: 'ja_JP.UTF-8', LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-TW')
    expect(resolveLang(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh-TW')
    expect(resolveLang('auto', { LANG: 'C' })).toBe('en')
    expect(resolveLang('auto', { LC_ALL: 'POSIX' })).toBe('en')
    expect(resolveLang('fr', { LANG: 'fr_FR.UTF-8' })).toBe(DEFAULT_LANG)
    expect(resolveLang('auto', {})).toBe(DEFAULT_LANG)
  })

  test('every language has every key and t falls back to English', async () => {
    const keys = Object.keys(MESSAGES.en).sort()
    for (const lang of LANGS) expect(Object.keys(MESSAGES[lang]).sort()).toEqual(keys)
    expect(t('ja', 'btn.cancel')).toBe('キャンセル')
    expect(t('zh-TW', 'btn.proceed')).toBe('執行')
    expect(t('en', 'more', { n: 3 })).toBe('+ 3 more')
  })
})

// ── Integration: the hold ──────────────────────────────────────────────────

const ROOT = '/home/u/proj'
const INSTANCE = JSON.stringify({ name: 'web-1', status: 'RUNNING', zone: 'projects/p/zones/us-central1-a', machineType: 'zones/us-central1-a/machineTypes/e2-small', creationTimestamp: '2026-09-01T10:00:00Z', labels: { env: 'prod' }, disks: [{ autoDelete: true }] })

type FakeFile = { text: string; mtimeMs: number }

type World = {
  clock: ReturnType<typeof mock.clock>
  ran: string[]
  lookups: string[][]
  toasts: string[]
  opened: { id: string; focus?: boolean }[]
  closed: string[]
  isPlaced: boolean
  gcloudMissing: boolean
  sleepMs: number
  /** The gcloud and kube config files the context line reads */
  files: Map<string, FakeFile>
  reads: string[]
}

const HOME = '/home/u'
const GCLOUD_DIR = `${HOME}/.config/gcloud`
const KUBECONFIG = `${HOME}/.kube/config`

/** A home with one active gcloud configuration and a GKE kube context. */
function defaultFiles(): Map<string, FakeFile> {
  return new Map<string, FakeFile>([
    [`${GCLOUD_DIR}/active_config`, { text: 'default\n', mtimeMs: 100 }],
    [`${GCLOUD_DIR}/configurations/config_default`, { text: '[core]\naccount = dev@example.com\nproject = side-project-staging\n\n[compute]\nzone = us-central1-a\nregion = us-central1\n', mtimeMs: 100 }],
    [KUBECONFIG, { text: 'apiVersion: v1\nclusters: []\ncontexts: []\ncurrent-context: gke_side-project-staging_us-central1_my-cluster\nkind: Config\n', mtimeMs: 100 }],
  ])
}

function world(on: any, options: Partial<Pick<World, 'isPlaced' | 'gcloudMissing' | 'files'>> = {}, env: Record<string, string> = { LANG: 'en_US.UTF-8', HOME }): World {
  const w: World = { clock: mock.clock(on, { now: 1_000_000 }), ran: [], lookups: [], toasts: [], opened: [], closed: [], isPlaced: true, gcloudMissing: false, sleepMs: 250, files: defaultFiles(), reads: [], ...options }
  mock.env(on, env)
  const value = (v: unknown) => ({ value: v })
  on('fs.read', (_$: any, e: any) => {
    w.reads.push(e.path)
    const f = w.files.get(e.path)
    return f === undefined ? { deny: `ENOENT: ${e.path}` } : value(f.text)
  })
  on('fs.stat', (_$: any, e: any) => {
    const f = w.files.get(e.path)
    return f === undefined ? { deny: `ENOENT: ${e.path}` } : value({ kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })
  })
  on('command.register', (_$: any, e: any) => value({ command: e.name }))
  const ok = (stdout: string, exitCode = 0, stderr = '') => value({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'sleep') {
      await w.clock.sleep(w.sleepMs)
      return ok('')
    }
    w.lookups.push(argv)
    if (w.gcloudMissing) return { deny: 'ENOENT: gcloud' }
    const joined = argv.join(' ')
    if (joined.startsWith('gcloud config get-value account')) return ok('dev@example.com\n')
    if (joined.startsWith('gcloud config get-value project')) return ok('demo-proj\n')
    if (joined.startsWith('gcloud config get-value compute/zone')) return ok('us-east1-b\n')
    if (joined.startsWith('gcloud config configurations list')) return ok('default\n')
    if (joined.includes(' describe ghost ')) return ok('', 1, 'ERROR: (gcloud.compute.instances.describe) Could not fetch resource:\n - The resource ghost was not found')
    if (joined.startsWith('gcloud projects describe')) return ok(JSON.stringify({ name: 'Demo', projectId: 'my-proj', lifecycleState: 'ACTIVE', createTime: '2025-01-01T00:00:00Z' }))
    if (joined.includes(' describe ')) return ok(INSTANCE)
    if (joined.startsWith('gcloud services list')) return ok('compute.googleapis.com\nrun.googleapis.com\n')
    if (joined.includes(' ls -r ')) return ok('gs://b/dir/:\ngs://b/dir/a\ngs://b/dir/b\ngs://b/dir/c\n')
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

const PANE = { plugin: 'gcloud-guard', component: 'Pane', requestId: 'gcloud-guard', props: {} } as const
const BAND = { plugin: 'gcloud-guard', component: 'AbovePrompt', props: {} } as const

async function cmd($: any, command: string, args = ''): Promise<string> {
  const r: any = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  return String(r?.text ?? '')
}

function bash($: any, command: string): Promise<any> {
  return $.tool.call({ tool: 'Bash', tool_use_id: `t-${Math.random().toString(36).slice(2)}`, command })
}

async function textsOf(ui: any): Promise<string[]> {
  const found = await ui.findAll({ type: 'Text' })
  return found.map((x: any) => String(x.text ?? ''))
}

const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l))

describe('gcloud-guard', () => {
  test('a delete is held, described, and Cancel refuses it with the English tail', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, 'gcloud compute instances delete web-1 --zone us-central1-a')
    await w.clock.settle()
    expect(w.opened).toEqual([{ id: 'gcloud-guard', focus: true }])
    expect(w.lookups.some(a => a.join(' ') === 'gcloud compute instances describe web-1 --format=json --zone=us-central1-a')).toBe(true)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const texts = await textsOf(ui)
    expect(has(texts, /gcloud-guard · destructive/)).toBe(true)
    expect(has(texts, /^delete compute instances web-1$/)).toBe(true)
    expect(has(texts, /demo-proj/)).toBe(true)
    expect(has(texts, /from gcloud config/)).toBe(true)
    expect(has(texts, /dev@example\.com/)).toBe(true)
    expect(has(texts, /us-central1-a/)).toBe(true)
    expect(has(texts, /web-1 · RUNNING · us-central1-a · e2-small · created 2026-09-01 · 1 labels · 1 disks \(1 auto-delete\)/)).toBe(true)
    expect(has(texts, /Claude is waiting on your answer/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    await w.clock.advance(300)
    const r = await call
    expect(typeof r.deny).toBe('string')
    expect(r.deny).toContain('the user pressed Cancel')
    expect(r.deny).toContain('delete compute instances web-1 in project demo-proj')
    expect(r.deny).toContain(DENY_TAIL)
    expect(w.ran).toEqual([])
    expect(w.closed).toEqual(['gcloud-guard'])
  })

  test('Proceed runs the command as written and toasts', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, 'gcloud compute instances delete web-1 --project=p1')
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const texts = await textsOf(ui)
    expect(has(texts, /p1/)).toBe(true)
    expect(has(texts, /from --project/)).toBe(true)
    await ui.press({ key: 'proceed' })
    await ui.unmount()
    await w.clock.advance(300)
    const r = await call
    expect(r.deny).toBe(undefined)
    expect(r.text).toBe('ran')
    expect(w.ran).toEqual(['gcloud compute instances delete web-1 --project=p1'])
    expect(w.toasts).toEqual(['gcloud-guard: running it'])
    // The account came from the config even though the project was a flag
    expect(w.lookups.some(a => a.join(' ').startsWith('gcloud config get-value account'))).toBe(true)
  })

  test('a narrow terminal draws the report in the band', async ($, on) => {
    const w = world(on, { isPlaced: false })
    await start($, w)
    const call = bash($, 'gcloud compute instances stop web-1 --zone z')
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    const texts = await textsOf(band)
    expect(has(texts, /gcloud-guard · mutating/)).toBe(true)
    expect(has(texts, /stop compute instances web-1/)).toBe(true)
    expect(has(texts, /ENGINE_DEFAULT/)).toBe(false)
    await band.press({ key: 'cancel' })
    await band.unmount()
    await w.clock.advance(300)
    const r = await call
    expect(r.deny).toContain(DENY_TAIL)
    expect(w.closed).toEqual([])
  })

  test('no answer within 10 minutes refuses the command', { timeoutMs: 20000 }, async ($, on) => {
    const w = world(on)
    await start($, w)
    w.sleepMs = 60_000
    const call = bash($, 'gcloud sql instances delete db --quiet')
    await w.clock.settle()
    await w.clock.advance(HOLD_LIMIT_MS + 120_000)
    const r = await call
    expect(r.deny).toContain('no answer within 10 minutes')
    expect(w.ran).toEqual([])
  })

  test('hold=destructive lets a create through untouched', { options: { hold: 'destructive' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    const r = await bash($, 'gcloud compute instances create web-9 --machine-type e2-small')
    expect(r.text).toBe('ran')
    expect(w.opened).toEqual([])
    expect(w.lookups).toEqual([])
  })

  test('a command that is not gcloud passes straight through', async ($, on) => {
    const w = world(on)
    await start($, w)
    const r = await bash($, 'ls -la && echo done')
    expect(r.text).toBe('ran')
    expect(w.opened).toEqual([])
    expect(w.lookups).toEqual([])
  })

  test('a missing target is reported, and gcloud missing still holds with a note', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, 'gcloud compute instances delete ghost --zone z')
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(has(await textsOf(ui), /ghost: not found/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    await w.clock.advance(300)
    await call

    w.gcloudMissing = true
    const call2 = bash($, 'gcloud compute instances delete web-1')
    await w.clock.settle()
    const ui2 = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const texts = await textsOf(ui2)
    expect(has(texts, /gcloud is not on PATH/)).toBe(true)
    await ui2.press({ key: 'proceed' })
    await ui2.unmount()
    await w.clock.advance(300)
    const r = await call2
    expect(r.text).toBe('ran')
  })

  test('a project delete shows the project and its enabled services', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, 'gcloud projects delete my-proj')
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const texts = await textsOf(ui)
    expect(has(texts, /shut down project my-proj \(30-day recovery window\)/)).toBe(true)
    expect(has(texts, /Demo · ACTIVE · created 2025-01-01/)).toBe(true)
    expect(has(texts, /2 services enabled/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    await w.clock.advance(300)
    await call
  })

  test('storage rm counts the objects; config set shows the current value', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, 'gsutil rm -r gs://b/dir')
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(has(await textsOf(ui), /gs:\/\/b\/dir: 3 objects/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    await w.clock.advance(300)
    await call

    const call2 = bash($, 'gcloud config set compute/zone us-central1-a')
    await w.clock.settle()
    const ui2 = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const texts = await textsOf(ui2)
    expect(has(texts, /switch gcloud config compute\/zone → us-central1-a \(now: us-east1-b\)/)).toBe(true)
    await ui2.press({ key: 'cancel' })
    await ui2.unmount()
    await w.clock.advance(300)
    await call2
  })

  test('two risky calls are held one after the other', async ($, on) => {
    const w = world(on)
    await start($, w)
    const first = bash($, 'gcloud compute instances delete a')
    const second = bash($, 'gcloud compute instances delete b')
    await w.clock.settle()
    expect(w.opened.length).toBe(1)
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(has(await textsOf(ui), /delete compute instances a$/)).toBe(true)
    await ui.press({ key: 'proceed' })
    await ui.unmount()
    await w.clock.advance(300)
    expect((await first).text).toBe('ran')
    await w.clock.advance(300)
    expect(w.opened.length).toBe(2)
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(has(await textsOf(ui), /delete compute instances b$/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    await w.clock.advance(300)
    expect((await second).deny).toContain(DENY_TAIL)
    expect(w.ran).toEqual(['gcloud compute instances delete a'])
  })

  test('language=ja draws the pane in Japanese and refuses with the English tail', { options: { language: 'ja' } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, 'gcloud compute instances delete web-1')
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const texts = await textsOf(ui)
    expect(has(texts, /gcloud-guard · 破壊的/)).toBe(true)
    expect(has(texts, /Claude はあなたの回答を待っています/)).toBe(true)
    const cancel = await ui.find({ key: 'cancel' })
    expect(cancel?.text).toBe('キャンセル')
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    await w.clock.advance(300)
    const r = await call
    expect(r.deny).toContain('ユーザーがキャンセルを押しました')
    expect(r.deny).toContain(DENY_TAIL)
  })

  test('the context line is read from the config files at start and drawn above the plugins beneath', async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(w.lookups).toEqual([])
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
    const texts = await textsOf(band)
    expect(texts[0]).toBe('☁ gcloud · project side-project-staging · account dev@example.com · config default · GKE my-cluster (us-central1)')
    expect(has(texts, /^─+$/)).toBe(true)
    expect(has(texts, /ENGINE_DEFAULT/)).toBe(true)
    await band.unmount()
    expect(await cmd($, 'gcloud-guard')).toContain('project         side-project-staging  (from the configuration file)')
    expect(await cmd($, 'gcloud-guard')).toContain('kube context    gke_side-project-staging_us-central1_my-cluster')
    expect(await cmd($, 'gcloud-guard')).toContain('hold setting    all + gsutil + config set')
  })

  test('the band is hidden when nothing is known, with show_context=false, and with /gcloud-guard off', async ($, on) => {
    const w = world(on, { files: new Map() })
    await start($, w)
    let texts = await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))
    expect(texts).toEqual(['ENGINE_DEFAULT'])
    expect(await cmd($, 'gcloud-guard')).toContain('no gcloud configuration found')
    w.files = defaultFiles()
    expect(await cmd($, 'gcloud-guard', 'refresh')).toContain('side-project-staging')
    expect(await cmd($, 'gcloud-guard', 'off')).toContain('hidden')
    texts = await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))
    expect(texts).toEqual(['ENGINE_DEFAULT'])
    await cmd($, 'gcloud-guard', 'on')
    texts = await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))
    expect(texts[0]).toContain('side-project-staging')
  })

  test('show_context=false draws nothing', { options: { show_context: false } }, async ($, on) => {
    const w = world(on)
    await start($, w)
    expect(await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))).toEqual(['ENGINE_DEFAULT'])
  })

  test('the timer re-reads only when a watched file changed', async ($, on) => {
    const w = world(on)
    await start($, w)
    const readsAtStart = w.reads.length
    await w.clock.advance(CONTEXT_TICK_MS * 3)
    expect(w.reads.length).toBe(readsAtStart)
    w.files.set(`${GCLOUD_DIR}/configurations/config_default`, { text: '[core]\nproject = other-proj\naccount = dev@example.com\n', mtimeMs: 200 })
    w.files.set(KUBECONFIG, { text: 'current-context: docker-desktop\n', mtimeMs: 200 })
    await w.clock.advance(CONTEXT_TICK_MS)
    expect(w.reads.length).toBeGreaterThan(readsAtStart)
    const texts = await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))
    expect(texts[0]).toBe('☁ gcloud · project other-proj · account dev@example.com · config default')
  })

  test('CLOUDSDK_CORE_PROJECT wins and is marked; KUBECONFIG with two files takes the one with a context', async ($, on) => {
    const files = defaultFiles()
    files.set('/k/empty', { text: 'kind: Config\n', mtimeMs: 1 })
    files.set('/k/second', { text: 'current-context: gke_p2_europe-west1_eu\n', mtimeMs: 1 })
    const w = world(on, { files }, { LANG: 'en_US.UTF-8', HOME, CLOUDSDK_CORE_PROJECT: 'env-proj', KUBECONFIG: '/k/empty:/k/second' })
    await start($, w)
    const texts = await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))
    expect(texts[0]).toBe('☁ gcloud · project env-proj ← CLOUDSDK_CORE_PROJECT · account dev@example.com · config default · GKE eu (europe-west1)')
    expect(await cmd($, 'gcloud-guard')).toContain('kubeconfig      /k/second')
  })

  test('a proceeded gcloud config set re-reads the context; a passing gcloud auth does too', async ($, on) => {
    const w = world(on)
    await start($, w)
    const call = bash($, 'gcloud config set project other-proj')
    await w.clock.settle()
    // The pane shows the GKE cluster the session is pointed at
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    const paneTexts = await textsOf(ui)
    expect(has(paneTexts, /GKE  /)).toBe(true)
    expect(has(paneTexts, /my-cluster \(us-central1\)/)).toBe(true)
    // Pretend the command rewrote the file before Proceed resolves
    w.files.set(`${GCLOUD_DIR}/configurations/config_default`, { text: '[core]\nproject = other-proj\naccount = dev@example.com\n', mtimeMs: 300 })
    await ui.press({ key: 'proceed' })
    await ui.unmount()
    await w.clock.advance(300)
    expect((await call).text).toBe('ran')
    let texts = await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))
    expect(texts[0]).toContain('project other-proj')
    // Not held, but touches the context: refreshed after it ran
    w.files.set(`${GCLOUD_DIR}/configurations/config_default`, { text: '[core]\nproject = third\naccount = ops@example.com\n', mtimeMs: 400 })
    expect((await bash($, 'gcloud auth login')).text).toBe('ran')
    texts = await textsOf(await $.ui.mount({ ...BAND, surface: 'terminal' } as any))
    expect(texts[0]).toContain('project third · account ops@example.com')
  })

  test('language=auto follows LANG', async ($, on) => {
    const w = world(on, {}, { LANG: 'zh_TW.UTF-8', HOME })
    await start($, w)
    const call = bash($, 'gcloud compute instances delete web-1')
    await w.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
    expect(has(await textsOf(ui), /gcloud-guard · 破壞性/)).toBe(true)
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    await w.clock.advance(300)
    await call
  })
})
