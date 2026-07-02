import type { ProcessingStatus } from "./queries"

// pending -> [held_for_review | ready] (the review gate) -> processed -> paid
export const STATUS_TONE: Record<
  ProcessingStatus,
  "neutral" | "cyan" | "coral" | "sun" | "grass" | "teal"
> = {
  pending: "neutral",
  held_for_review: "coral",
  ready: "teal",
  processed: "sun",
  paid: "grass",
}

export const STATUS_LABEL: Record<ProcessingStatus, string> = {
  pending: "pending",
  held_for_review: "held for review",
  ready: "ready",
  processed: "processed",
  paid: "paid",
}
