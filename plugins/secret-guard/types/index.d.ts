// secret-guard: data types and the $.state contract.

export type GuardLang = 'en' | 'zh-TW' | 'ja'

/** One redaction the session saw: the label and where it happened, never the value. */
export type RecentHit = {
  /** The placeholder label, e.g. `google api key` */
  label: string
  /** Which door the text came in by: `prompt`, `context`, `attachment`, `tool-result`, ... */
  where: string
  /** The subagent whose conversation carried it; null on the main conversation */
  agent: string | null
  /** When, in `$.clock.now()` milliseconds */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'secret-guard': {
      lang: GuardLang
      /** `/secret-guard off` for this session */
      isPaused: boolean
      /** Redactions this session, in all */
      total: number
      /** Redactions this session, by label */
      byLabel: Record<string, number>
      /** The newest redactions (at most 20), newest last */
      recent: RecentHit[]
      /** `custom_patterns` lines that did not compile, reported once in the band */
      badPatterns: string[]
    }
  }
}
