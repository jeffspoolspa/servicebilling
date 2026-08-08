/**
 * The intake ledger: versioned translations (tier 2), raw deltas (tier 1),
 * and the failed-intake quarantine — failure is a stored state, never a
 * discard; a fixed factory replays the failures as if never broken.
 */
export interface IntakeStore {
  latest(ionTaskId: string): Promise<{ observedAt: string; translation: unknown } | null>
  recordTranslation(ionTaskId: string, observedAt: string, translation: unknown, rawDelta: Record<string, unknown>): Promise<void>
  recordFailure(ionTaskId: string | null, observedAt: string, failed: string, raw: unknown): Promise<void>
  replayableFailures(limit: number): Promise<{ id: string; raw: unknown }[]>
}
