import type { ProcessingStatus } from "./queries"

// pending -> ion_matched -> [needs_review | ready_to_process] -> processed
export const STATUS_ORDER: ProcessingStatus[] = [
  "pending",
  "ion_matched",
  "needs_review",
  "ready_to_process",
  "processed",
]

export const STATUS_TONE: Record<
  ProcessingStatus,
  "neutral" | "cyan" | "coral" | "sun" | "grass" | "teal" | "indigo"
> = {
  pending: "neutral",
  ion_matched: "indigo",
  needs_review: "coral",
  ready_to_process: "teal",
  processed: "grass",
}

export const STATUS_LABEL: Record<ProcessingStatus, string> = {
  pending: "pending",
  ion_matched: "ion matched",
  needs_review: "needs review",
  ready_to_process: "ready",
  processed: "processed",
}

export const REASON_LABEL: Record<string, string> = {
  ion_amount_mismatch: "ION amount mismatch",
  subtotal_mismatch: "subtotal mismatch",
  high_flag: "HIGH audit flag",
  reconcile_mismatch: "reconcile mismatch",
  credit_error: "credit apply failed",
}
