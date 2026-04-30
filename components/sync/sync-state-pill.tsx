"use client"

import { Loader2, AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils/cn"

/**
 * Visual indicator for the sync_state of a QBO-mirrored row.
 *
 * Renders nothing for the steady state ('synced') so there's no visual
 * noise on rows that are fine. Renders a colored dot + label for any
 * non-synced state, with an optional tooltip showing the error.
 *
 * Used in row-level views (queue table, needs-attention list, detail
 * pages). The global sidebar badge is a separate component
 * (SyncIssuesBadge) that aggregates across all rows.
 */

export type SyncState =
  | "synced"
  | "pending"
  | "awaiting_propagation"
  | "sync_failed"
  | "drift_detected"

interface Props {
  state: SyncState | null | undefined
  error?: string | null
  /** Hide the pill when synced. Default true — most lists don't need to confirm "fine". */
  hideWhenSynced?: boolean
  /** Compact (just the dot) vs full (dot + text). Default 'full'. */
  size?: "compact" | "full"
  className?: string
}

const STATE_CONFIG = {
  synced: {
    icon: CheckCircle2,
    label: "Synced",
    tone: "text-grass",
    dotClass: "bg-grass",
    spin: false,
  },
  pending: {
    icon: Loader2,
    label: "Saving",
    tone: "text-cyan",
    dotClass: "bg-cyan",
    spin: true,
  },
  awaiting_propagation: {
    icon: Loader2,
    label: "Syncing",
    tone: "text-cyan",
    dotClass: "bg-cyan",
    spin: true,
  },
  sync_failed: {
    icon: AlertCircle,
    label: "Failed",
    tone: "text-coral",
    dotClass: "bg-coral",
    spin: false,
  },
  drift_detected: {
    icon: AlertTriangle,
    label: "Drift",
    tone: "text-sun",
    dotClass: "bg-sun",
    spin: false,
  },
} as const

export function SyncStatePill({
  state,
  error,
  hideWhenSynced = true,
  size = "full",
  className,
}: Props) {
  if (!state || (state === "synced" && hideWhenSynced)) return null

  const config = STATE_CONFIG[state]
  if (!config) return null

  const Icon = config.icon
  const tooltip = error
    ? `${config.label}: ${error}`
    : config.label

  if (size === "compact") {
    return (
      <span
        title={tooltip}
        className={cn(
          "inline-block w-1.5 h-1.5 rounded-full shrink-0",
          config.dotClass,
          config.spin && "animate-pulse",
          className,
        )}
      />
    )
  }

  return (
    <span
      title={tooltip}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em]",
        config.tone,
        className,
      )}
    >
      <Icon
        className={cn("w-3 h-3", config.spin && "animate-spin")}
        strokeWidth={2.5}
      />
      <span>{config.label}</span>
    </span>
  )
}
