"use client"

import { useEffect, useState } from "react"

/**
 * The publish dialog — the one place a routing change is RULED on and
 * watched (RULED 2026-08-09, Carter).
 *
 * Before: every row's write shape, and the bridge visits the planner
 * proposes — each one accepted or declined, with its DATE editable,
 * because "give them a free visit on the 18th" is a business decision
 * nobody should discover after the fact.
 *
 * During: it STAYS OPEN. Each row shows the declared steps crossing off
 * as they land, read from the publication ledger — not a pill that hides
 * which change is where. A run that fails names the row and the step.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export interface PreviewRow {
  quotaId: string
  customer: string
  ionTaskId: string | null
  from: { weekday: number; tech: string }[]
  to: { weekday: number; tech: string }[]
  cadence: string
  parity: { from: string; to: string } | null
  validity: string
  effectiveDate: string | null
  violations: { bound?: string; days?: number }[]
  bridges: { date: string; tech: string; techId: string; defaultAccept: boolean }[]
}

export interface MoveProgress {
  ionTaskId: string
  status: string
  writeKind: string
  steps: { step: string; status: string }[]
}

/** the declared process, in order, for the progress rail */
const STEP_LABEL: Record<string, string> = {
  read_current: "read ION",
  plan: "plan",
  declare_supersession: "declare",
  end_old: "end old",
  amend_form: "amend",
  create_successor: "create",
  verify_target: "verify task",
  record_book: "record",
  converge_placement: "converge",
  verify_floor: "verify floor",
}

export function PublishDialog({
  changeCount, onCancel, onConfirm, running, progress, outcome, onClose,
  preview, previewError,
}: {
  changeCount: number
  preview: PreviewRow[] | null
  previewError: string | null
  running: boolean
  progress: Map<string, MoveProgress>
  outcome: string | null
  onCancel: () => void
  onConfirm: (decisions: { quotaId: string; accepted: boolean; date: string }[]) => void
  onClose: () => void
}) {
  // bridge rulings, keyed by quota: default follows the planner's own
  // recommendation (biweekly seams pre-accepted), date editable
  const [rulings, setRulings] = useState<Map<string, { accepted: boolean; date: string }>>(new Map())
  useEffect(() => {
    if (!preview) return
    const next = new Map<string, { accepted: boolean; date: string }>()
    for (const r of preview) {
      if (r.bridges.length) next.set(r.quotaId, { accepted: r.bridges[0].defaultAccept, date: r.bridges[0].date })
    }
    setRulings(next)
  }, [preview])

  const withBridges = (preview ?? []).filter((r) => r.bridges.length > 0)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6">
      <div className="flex h-[88vh] w-[min(1100px,94vw)] flex-col rounded-xl border border-line bg-bg-surface shadow-2xl">
        {/* ------------------------------------------------ header */}
        <div className="flex items-center gap-3 border-b border-line-soft px-5 py-3">
          <div className="text-[14px] font-medium text-ink">
            {running
              ? `Publishing ${changeCount} change${changeCount === 1 ? "" : "s"} to ION`
              : `Publish ${changeCount} change${changeCount === 1 ? "" : "s"} to ION`}
          </div>
          <span className="flex-1" />
          {outcome && <span className="text-[11px] text-ink-mute">{outcome}</span>}
        </div>

        {/* ------------------------------------------------ body */}
        <div className="flex-1 overflow-auto px-5 py-3">
          {previewError && (
            <div className="rounded-lg border border-coral/50 bg-coral/10 p-3 text-[12px] text-coral">
              {previewError}
            </div>
          )}
          {!preview && !previewError && (
            <div className="py-8 text-center text-[12px] text-ink-mute">Checking each change against ION…</div>
          )}

          {!running && withBridges.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="pb-1 text-[12px] font-medium text-amber-200">
                {withBridges.length} transition{withBridges.length === 1 ? "" : "s"} leaves a gap longer than the cadence allows
              </div>
              <div className="pb-2 text-[11px] leading-relaxed text-ink-mute">
                A bridge visit is a one-time no-charge stop that covers the gap. Choose whether to give it
                and on which date — the customer is not billed for it.
              </div>
              {withBridges.map((r) => {
                const ruling = rulings.get(r.quotaId)
                return (
                  <div key={r.quotaId} className="flex items-center gap-2 border-t border-line-soft/40 py-1.5 text-[11px] first:border-0">
                    <input
                      type="checkbox"
                      checked={ruling?.accepted ?? false}
                      onChange={(e) => setRulings((m) => new Map(m).set(r.quotaId, {
                        accepted: e.target.checked, date: ruling?.date ?? r.bridges[0].date,
                      }))}
                    />
                    <span className="w-48 truncate text-ink-dim">{r.customer}</span>
                    <span className="text-ink-mute">free visit on</span>
                    <input
                      type="date"
                      className="rounded border border-line bg-transparent px-1.5 py-0.5 text-[11px] text-ink disabled:opacity-40"
                      value={ruling?.date ?? r.bridges[0].date}
                      disabled={!(ruling?.accepted ?? false)}
                      onChange={(e) => setRulings((m) => new Map(m).set(r.quotaId, {
                        accepted: ruling?.accepted ?? true, date: e.target.value,
                      }))}
                    />
                    <span className="text-ink-mute">with {r.bridges[0].tech}</span>
                  </div>
                )
              })}
            </div>
          )}

          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="border-b border-line-soft text-left text-ink-mute">
                <th className="py-1.5 font-normal">Customer</th>
                <th className="font-normal">From</th>
                <th className="font-normal">To</th>
                <th className="font-normal">Write</th>
                <th className="font-normal">{running ? "Progress" : "First service"}</th>
              </tr>
            </thead>
            <tbody>
              {(preview ?? []).map((r) => {
                const prog = r.ionTaskId ? progress.get(r.ionTaskId) : undefined
                return (
                  <tr key={r.quotaId} className="border-b border-line-soft/40">
                    <td className="py-1.5 pr-2 text-ink-dim">{r.customer}</td>
                    <td className="pr-2 text-ink-mute">
                      {r.parity
                        ? r.parity.from
                        : r.from.map((s) => `${DAYS[s.weekday]} ${s.tech}`).join(", ") || "—"}
                    </td>
                    <td className="pr-2 text-ink">
                      {r.parity
                        ? r.parity.to
                        : r.to.map((s) => `${DAYS[s.weekday]} ${s.tech}`).join(", ") || "—"}
                    </td>
                    <td className="pr-2 text-ink-mute">{r.cadence}</td>
                    <td>
                      {running
                        ? <StepRail prog={prog} />
                        : <span className="text-ink-mute">{r.effectiveDate ?? "—"}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {!running && (preview ?? []).some((r) => r.violations.length > 0) && (
            <div className="mt-3 rounded-lg border border-coral/40 bg-coral/5 p-3 text-[11px] text-coral">
              Some changes violate their cadence bounds and will refuse the whole publication.
            </div>
          )}
        </div>

        {/* ------------------------------------------------ footer */}
        <div className="flex items-center gap-2 border-t border-line-soft px-5 py-3">
          <span className="flex-1 text-[11px] text-ink-mute">
            {running
              ? "Writing to ION — this dialog stays open until every change reports."
              : "Every change supersedes: the old task ends and a successor is created, verified by reading ION back."}
          </span>
          {running ? (
            <button
              className="rounded-full border border-line px-3 py-1 text-[11px] text-dim hover:text-ink disabled:opacity-40"
              disabled={!outcome}
              onClick={onClose}
            >
              {outcome ? "Close and refresh the board" : "Running…"}
            </button>
          ) : (
            <>
              <button
                className="rounded-full border border-line px-3 py-1 text-[11px] text-dim hover:text-ink"
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                className="rounded-full border border-emerald-500/60 bg-emerald-500/25 px-3 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/35 disabled:opacity-40"
                disabled={!preview || !!previewError}
                onClick={() => onConfirm(
                  [...rulings.entries()].map(([quotaId, r]) => ({ quotaId, accepted: r.accepted, date: r.date })),
                )}
              >
                {`Confirm — write ${changeCount} to ION`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** The declared steps for one move, crossing off as ION confirms them. */
function StepRail({ prog }: { prog: MoveProgress | undefined }) {
  if (!prog) return <span className="text-ink-mute">waiting…</span>
  const failed = prog.steps.find((s) => s.status === "failed")
  return (
    <span className="flex flex-wrap items-center gap-1">
      {prog.steps.map((s, i) => (
        <span
          key={i}
          className={`rounded px-1 py-0.5 text-[9.5px] ${
            s.status === "failed" ? "bg-coral/25 text-coral" : "bg-emerald-500/15 text-emerald-300"
          }`}
          title={s.step}
        >
          {STEP_LABEL[s.step] ?? s.step}
        </span>
      ))}
      {prog.status === "running" && !failed && <span className="text-[9.5px] text-ink-mute">…</span>}
      {failed && <span className="text-[9.5px] text-coral">halted</span>}
      {prog.status === "done" && <span className="text-[9.5px] text-emerald-300">done</span>}
      {prog.status === "produced_no_change" && (
        <span className="text-[9.5px] text-amber-300">NO write — intent lost</span>
      )}
      {prog.status === "landed_unverified" && (
        <span className="text-[9.5px] text-amber-300">ION written, floor unverified</span>
      )}
    </span>
  )
}
