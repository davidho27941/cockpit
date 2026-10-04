// auto-handover data types and the $.state contract.

/** Where the handover is: idle, asking the model for a note, or compacting. */
export type HandoverPhase = 'idle' | 'writing' | 'compacting'

/** What started this handover. */
export type HandoverTrigger = 'threshold' | 'command' | 'manual' | 'auto'

/** The most recent handover, for display. */
export type HandoverRecord = {
  at: number
  /** Absolute path of the note. */
  file: string
  trigger: HandoverTrigger
  /** Context usage (%) when the handover started. */
  percent: number | null
  /** Usage (%) after compaction; null when unknown. */
  percentAfter: number | null
}

/** The language of the UI and of the note. */
export type HandoverLang = 'en' | 'zh-TW' | 'ja'

declare module 'claude-code' {
  interface PluginState {
    'auto-handover': {
      /** The most recent context usage reading (%). */
      lastPercent: number | null
      phase: HandoverPhase
      last: HandoverRecord | null
      /** Handovers completed in this session. */
      count: number
      /** True after /handover off: no automatic handovers (/handover now still works). */
      isPaused: boolean
      /** Why the folder setting is unusable or the home directory unknown; null when fine. */
      failure: string | null
      /** The resolved language, so render hooks can read it. */
      lang: HandoverLang
    }
  }
}
