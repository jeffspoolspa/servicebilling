import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * The shared HISTORY renderer — extracted from the service-billing invoice
 * history panel so every aggregate's activity feed (invoice, billing month,
 * work order) reads identically: standardized action rows with actor tags,
 * stage-boundary rules that bracket workflow runs, and expandable detail
 * (rule checks, before→after changes). Callers own their VOCABULARY — they
 * map their events to rows; this owns only the reading experience.
 */

export interface HistoryRow {
  key: string
  at: string
  /** A stage boundary — rendered as a coloured rule bracketing a run. */
  boundary?: { label: string; edge: "start" | "end"; stage: "preprocess" | "charge" }
  /** stream sequence — tiebreaker when several events share a timestamp. */
  seq?: number
  action: React.ReactNode | null
  tag: string | null
  note?: string | null
  changes?: [string, { from: string | null; to: string | null }][]
  checks?: [string, boolean][]
  /** A collapsed set — one row for many like events, expandable to the list. */
  items?: { label: React.ReactNode; note?: string | null }[]
  itemsSummary?: string
}

export function HistoryTimeline({
  rows,
  title = "History",
  emptyText = "No activity yet.",
  headerExtra,
}: {
  rows: HistoryRow[]
  title?: string
  emptyText?: string
  headerExtra?: React.ReactNode
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {headerExtra}
        </CardHeader>
        <CardBody className="text-ink-mute text-sm">{emptyText}</CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {headerExtra}
        <span className="ml-auto text-[11px] text-ink-mute">
          {rows.filter((r) => !r.boundary).length} event
          {rows.filter((r) => !r.boundary).length === 1 ? "" : "s"}
        </span>
      </CardHeader>
      <CardBody className="py-1">
        <ol>
          {rows.map((r) =>
            r.boundary ? (
              <li key={r.key} className="flex items-center gap-2 py-1.5">
                <span
                  className={
                    "h-px flex-1 " + (r.boundary.stage === "charge" ? "bg-cyan/30" : "bg-grass/30")
                  }
                />
                <span
                  className={
                    "shrink-0 text-[10px] uppercase tracking-[0.1em] " +
                    (r.boundary.stage === "charge" ? "text-cyan/70" : "text-grass/70")
                  }
                >
                  {r.boundary.label}
                  {r.boundary.edge === "end" ? " done" : ""}
                </span>
                <span
                  className={
                    "h-px w-4 " + (r.boundary.stage === "charge" ? "bg-cyan/30" : "bg-grass/30")
                  }
                />
              </li>
            ) : (
              <li key={r.key} className="py-2.5 border-b border-line-soft/60 last:border-b-0">
                <div className="flex items-start gap-2">
                  <span className="flex-1 min-w-0 text-[13px] text-ink leading-snug">{r.action}</span>
                  {r.tag && (
                    <span className="shrink-0 text-[10px] text-ink-mute border border-line-soft rounded-full px-1.5 py-px">
                      {r.tag}
                    </span>
                  )}
                  <span
                    className="shrink-0 text-[11px] text-ink-mute whitespace-nowrap"
                    title={new Date(r.at).toLocaleString()}
                  >
                    {new Date(r.at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {r.note && <div className="mt-0.5 text-[11px] text-ink-mute">{r.note}</div>}
                {r.checks && r.checks.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-[11px] text-ink-mute cursor-pointer select-none hover:text-ink-dim">
                      rules applied
                    </summary>
                    <ul className="mt-1 space-y-0.5 pl-4 list-none">
                      {r.checks.map(([rule, ok]) => (
                        <li key={rule} className="text-[11px]">
                          <span className={ok ? "text-grass" : "text-coral"}>{ok ? "✓" : "✗"}</span>{" "}
                          <span className="text-ink-dim">{rule.replace(/_/g, " ")}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {r.items && r.items.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-[11px] text-ink-mute cursor-pointer select-none hover:text-ink-dim">
                      {r.itemsSummary ?? `${r.items.length} item${r.items.length === 1 ? "" : "s"}`}
                    </summary>
                    <ul className="mt-1 space-y-1 pl-4 list-none">
                      {r.items.map((it, i) => (
                        <li key={i} className="text-[11px]">
                          <span className="text-ink-dim">{it.label}</span>
                          {it.note && <div className="text-ink-mute">{it.note}</div>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {r.changes && r.changes.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-[11px] text-ink-mute cursor-pointer select-none hover:text-ink-dim">
                      {r.changes.length} change{r.changes.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-1 space-y-0.5 pl-4 list-disc marker:text-ink-mute">
                      {r.changes.map(([field, c]) => (
                        <li key={field} className="text-[11px] text-ink-dim">
                          <span className="text-ink-mute">{field.replace(/_/g, " ")}:</span>{" "}
                          <span className="line-through opacity-60">{c.from ?? "—"}</span> →{" "}
                          <span className="text-ink">{c.to ?? "—"}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ),
          )}
        </ol>
      </CardBody>
    </Card>
  )
}
