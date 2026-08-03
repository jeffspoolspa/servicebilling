"use client"

import { formatCurrency } from "@/lib/utils/format"

/**
 * The why-flagged context block, extracted VERBATIM from the bill-review
 * workbench so both workbenches (bill review and audit findings) render the
 * exact same graph: monthly chem $ bars (season-matched months brighter,
 * this month in sun), the dashed peer-median line, and the this-month /
 * self-median / peer-median stat row.
 */

export interface FlagContext {
  peerGroup: string | null
  peerMedian: number | null
  peerN: number | null
  history: { month: string; chem_usd: number; visits: number }[]
}

// canonical season buckets (matches billing_audit.v_customer_month_cpv):
// summer May-Aug, shoulder (fall/spring) Mar-Apr + Sep-Oct, winter Nov-Feb
function seasonOf(month: string): "summer" | "shoulder" | "winter" {
  const m = parseInt(month.slice(5, 7), 10)
  if (m >= 5 && m <= 8) return "summer"
  if (m === 3 || m === 4 || m === 9 || m === 10) return "shoulder"
  return "winter"
}
const SEASON_LABEL = { summer: "summer", shoulder: "fall/spring", winter: "winter" } as const

export function ChemHistoryContext({ flagContext }: { flagContext: FlagContext }) {
  if (flagContext.history.length === 0) return null
  const hist = flagContext.history
  const thisMonth = hist[hist.length - 1]
  const season = seasonOf(String(thisMonth.month))
  const median = (xs: number[]) => {
    if (!xs.length) return null
    const a = [...xs].sort((x, y) => x - y)
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
  }
  // self median compares like months: same season only (chem usage swings
  // seasonally); fall back to all prior months when the season has no
  // history yet
  const sameSeason = hist.slice(0, -1)
    .filter((h) => seasonOf(String(h.month)) === season)
    .map((h) => Number(h.chem_usd))
  const allPrior = hist.slice(0, -1).map((h) => Number(h.chem_usd))
  const seasonal = sameSeason.length > 0
  const selfBasis = seasonal ? sameSeason : allPrior
  const selfMedian = median(selfBasis)
  const peerMedian = flagContext.peerMedian != null ? Number(flagContext.peerMedian) : null
  const max = Math.max(...hist.map((h) => Number(h.chem_usd)), peerMedian ?? 0, 1)
  return (
    <div className="px-5 pb-5 pt-1">
      <div className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute mb-2">
        Chem $ by month
      </div>
      <div className="flex items-end gap-1 h-[72px] relative">
        {peerMedian != null && (
          <div
            className="absolute left-0 right-0 border-t border-dashed border-ink-mute/50"
            style={{ bottom: `${Math.min(100, (peerMedian / max) * 100)}%` }}
            title={`Peer median ${formatCurrency(peerMedian)}`}
          />
        )}
        {hist.map((h, i) => {
          const last = i === hist.length - 1
          return (
            <div
              key={h.month}
              className="flex-1 flex flex-col items-center gap-1 min-w-0"
              title={`${String(h.month).slice(0, 7)} · ${formatCurrency(Number(h.chem_usd))} · ${h.visits} visits`}
            >
              <div
                className={`w-full rounded-t ${
                  last ? "bg-sun"
                  : seasonOf(String(h.month)) === season ? "bg-cyan/50" : "bg-cyan/15"
                }`}
                style={{ height: `${Math.max(2, (Number(h.chem_usd) / max) * 64)}px` }}
              />
              <span className="font-mono text-[8px] text-ink-mute">
                {new Date(h.month + "T12:00:00Z").toLocaleDateString("en-US", { month: "narrow", timeZone: "UTC" })}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <div>
          <div className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">This month</div>
          <div className="font-mono text-[13px] text-sun">{formatCurrency(Number(thisMonth.chem_usd))}</div>
        </div>
        <div>
          <div className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">
            Self median{" "}
            <span className="normal-case">
              ({seasonal ? `${SEASON_LABEL[season]}, ${selfBasis.length} mo` : `all ${selfBasis.length} mo`})
            </span>
          </div>
          <div className="font-mono text-[13px] text-ink">
            {selfMedian != null ? formatCurrency(selfMedian) : "—"}
          </div>
        </div>
        <div>
          <div className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-ink-mute">
            Peer median{" "}
            <span className="normal-case">
              (this month{flagContext.peerN != null ? `, n=${flagContext.peerN}` : ""})
            </span>
          </div>
          <div className="font-mono text-[13px] text-ink">
            {peerMedian != null ? formatCurrency(peerMedian) : "—"}
          </div>
        </div>
      </div>
      {flagContext.peerGroup && (
        <div className="mt-1 text-[10px] text-ink-mute">{flagContext.peerGroup}</div>
      )}
    </div>
  )
}
