// secret-guard: data types and the $.state contract.

export type GuardLang = 'en' | 'zh-TW' | 'ja'

/**
 * One redaction the session saw: the label, where it happened and a fingerprint,
 * never the value. Kept for this session only.
 */
export type RecentHit = {
  /** The placeholder label, e.g. `google api key` */
  label: string
  /** Which door the text came in by: `prompt`, `context`, `attachment`, `tool-result`, ... */
  where: string
  /** The subagent whose conversation carried it; null on the main conversation */
  agent: string | null
  /** When, in `$.clock.now()` milliseconds */
  at: number
  /** The tool whose result carried it (`Read`, `Bash`, `Grep`, ...); absent for prompts, context and attachments */
  tool?: string
  /**
   * Where the text came from: a file path for tools that name one, else the Bash
   * command or the Grep pattern (redacted itself, at most 120 characters); `prompt`,
   * a context block's name or an attachment's type otherwise. Never the tool's output.
   */
  source?: string
  /** 1-based line of the match in the scanned text (Read's own line numbers when present) */
  line?: number
  /**
   * `#` + the first 8 hex digits of HMAC-SHA256 over the value, keyed with a random
   * key made for this session: the same value gets the same fingerprint within the
   * session, and nothing outside the session can compare or reverse it. Absent when
   * the `fingerprints` setting is off.
   */
  fingerprint?: string
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
      /** The newest redactions (at most 100), newest last */
      recent: RecentHit[]
      /** This session's fingerprint key, hex; kept here so a hot reload keeps fingerprints stable */
      fpKey: string
      /** `custom_patterns` lines that did not compile, reported once in the band */
      badPatterns: string[]
    }
  }
}
