"use client"

import { useState, type ReactNode } from "react"

/**
 * Tab container for the two views over the same money:
 *   Applied payments — billing.payment_invoice_links (what IS applied)
 *   Credit review    — billing.invoice_credit_decisions (what was considered
 *                      during pre-processing and each credit's outcome)
 * A credit applied during review appears in both — links is the relationship
 * mirror, decisions is the frozen review snapshot.
 *
 * Children are server-rendered cards; both mount, the inactive one hides —
 * cheap, and tab switches keep client state (e.g. an open Complete-review
 * note field).
 */
export function PaymentsCreditsTabs({
  appliedCount,
  toDecideCount,
  applied,
  credits,
}: {
  appliedCount: number
  toDecideCount: number
  applied: ReactNode
  credits: ReactNode
}) {
  // Land the user on the tab that needs attention.
  const [tab, setTab] = useState<"applied" | "credits">(
    toDecideCount > 0 || appliedCount === 0 ? "credits" : "applied",
  )

  const tabBtn = (key: "applied" | "credits", label: string, badge?: string) => (
    <button
      onClick={() => setTab(key)}
      className={`px-3 py-1.5 text-[11px] uppercase tracking-[0.08em] rounded-md transition-colors ${
        tab === key
          ? "bg-bg-elev text-ink border border-line"
          : "text-ink-mute hover:text-ink-dim border border-transparent"
      }`}
    >
      {label}
      {badge && (
        <span className={`ml-1.5 ${tab === key ? "text-sun" : "text-ink-mute"}`}>
          {badge}
        </span>
      )}
    </button>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {tabBtn("applied", "Applied payments", appliedCount > 0 ? String(appliedCount) : undefined)}
        {tabBtn("credits", "Credit review", toDecideCount > 0 ? `${toDecideCount} to decide` : undefined)}
      </div>
      <div className={tab === "applied" ? "" : "hidden"}>{applied}</div>
      <div className={tab === "credits" ? "" : "hidden"}>{credits}</div>
    </div>
  )
}
