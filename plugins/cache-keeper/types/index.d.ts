// cache-keeper data types and its $.state contract.

/** This session's warming state; kept across hot reloads, partly reset on /clear */
export type KeeperState = {
  /** When the last real model request went out (main-loop turn.step, turn.complete, or our own poke); null = none yet */
  lastRequestAt: number | null
  /** When the last real turn started; the idle cap counts from here */
  lastRealTurnAt: number | null
  /** When we last tried to poke (success or failure); backoff counts from here */
  lastAttemptAt: number | null
  /** Successful pokes */
  pokes: number
  /** Failed pokes */
  failures: number
  /** Cache-read tokens of the last successful poke */
  lastCacheRead: number | null
  /** Uncached input tokens of the last successful poke (input + cache_creation) */
  lastInput: number | null
  /** True after /cache-keeper off */
  isPaused: boolean
  /** Current backoff in milliseconds; 0 = none */
  backoffMs: number
  /** A poke is in flight */
  isPoking: boolean
  /** A main-loop turn is running */
  isTurnRunning: boolean
  /** The idle-cap notice has been shown once */
  isCapNoticed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': {
      state: KeeperState
      /** Written on every timer tick, only so the countdown redraws */
      tickAt: number
      /** The resolved UI language: 'en', 'zh-TW' or 'ja' */
      lang: string
    }
  }
}
