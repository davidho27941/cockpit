// gcloud-guard: data types and the $.state contract.

export type GuardLang = 'en' | 'zh-TW' | 'ja'

/** How much a command changes: delete-class, update-class, or create-class. */
export type Severity = 'destructive' | 'mutating' | 'create'

export type GuardTool = 'gcloud' | 'gsutil'

export type Track = 'ga' | 'alpha' | 'beta'

/** The global flags read off the command line. */
export type RiskFlags = {
  project?: string
  account?: string
  configuration?: string
  zone?: string
  region?: string
  location?: string
  quiet: boolean
  impersonate?: string
}

/** What the classifier found: the first gcloud / gsutil segment that would change something. */
export type Risk = {
  tool: GuardTool
  track: Track
  /** The command group words before the verb, e.g. ['compute', 'instances'] */
  path: string[]
  verb: string
  severity: Severity
  /** A finer label for the UI: 'deploy', 'local-config', 'storage', 'iam', 'build', 'unknown' */
  kind?: string
  /** Positional words after the verb: resource names, URLs, properties */
  targets: string[]
  flags: RiskFlags
  /** Every other flag on the segment, by name without the dashes; `true` when it took no value */
  extra: Record<string, string | true>
  /** The segment as written */
  raw: string
  /** Set when the target is a whole project, organization or folder */
  scope?: 'project' | 'org' | 'folder'
  /** The verb was not in the table; held to be safe */
  unknownVerb?: boolean
}

export type ReportContext = {
  account: string | null
  project: string | null
  projectSource: 'flag' | 'config' | 'unknown'
  configuration: string | null
  location: string | null
  track: Track
  quiet: boolean
  impersonate: string | null
}

export type Report = {
  severity: Severity
  headline: string
  context: ReportContext
  /** Facts about the targets, at most 12 */
  lines: string[]
  /** Caveats: a describe that failed, a missing gcloud, deletion protection */
  notes: string[]
}

/** What the render hooks read: the hold as a frozen value. The decision lives in the module. */
export type HeldView = {
  id: number
  command: string
  risk: Risk
  report: Report | null
  where: 'pane' | 'band'
}

declare module 'claude-code' {
  interface PluginState {
    'gcloud-guard': {
      lang: GuardLang
      held: HeldView | null
    }
  }
}
