"use client"

/**
 * The unpublished-changes ledger as the app DataTable: search, office/tech/day
 * facets, sortable columns, and header-checkbox selection (with a caret menu
 * for all / page / none) driving bulk revert. Purely presentational — rows in,
 * revert indices out. The parent remounts it (key) whenever the change list
 * shifts, so index-keyed selection can never go stale.
 */

import { useEffect, useRef, useState } from "react"
import type { ColumnDef, Row, Table as TanTable } from "@tanstack/react-table"
import { ChevronDown } from "lucide-react"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"

export interface ChangeRow {
  /** Position in the plan's change list — the revert key. */
  index: number
  customer: string
  office: string
  fromDay: string | null
  fromTech: string | null
  toDay: string | null
  toTech: string | null
  netMinutes: number | null
  netMi: number | null
}

/** What kind of disruption a change is, read straight off its two sides. */
function kindOf(r: ChangeRow): string {
  if (r.toDay?.startsWith("week")) return "rephased"
  if (!r.fromDay) return "placed"
  if (!r.toDay) return "removed"
  const tech = r.fromTech !== r.toTech
  const day = r.fromDay !== r.toDay
  return tech && day ? "tech+day" : tech ? "tech" : "day"
}

const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "week A", "week B"]

const sideText = (day: string | null, tech: string | null) =>
  day ? `${day}${tech ? ` · ${tech}` : ""}` : "unplaced"

/** Sort a From/To column by day-of-week first, then tech name. */
const bySide =
  (get: (r: ChangeRow) => [string | null, string | null]) =>
  (a: Row<ChangeRow>, b: Row<ChangeRow>) => {
    const rank = (r: ChangeRow): [number, string] => {
      const [d, t] = get(r)
      const di = d ? DAY_ORDER.indexOf(d) : DAY_ORDER.length
      return [di < 0 ? DAY_ORDER.length : di, t ?? ""]
    }
    const [da, ta] = rank(a.original)
    const [db, tb] = rank(b.original)
    return da - db || ta.localeCompare(tb)
  }

function Side({ day, tech }: { day: string | null; tech: string | null }) {
  if (!day) return <span className="text-ink-mute">unplaced</span>
  return (
    <span className="block truncate whitespace-nowrap" title={tech ? `${day} · ${tech}` : day}>
      <Chip>{day}</Chip>
      {tech && (
        <>
          {" "}
          <Chip>{tech}</Chip>
        </>
      )}
    </span>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-line bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-ink-dim">
      {children}
    </span>
  )
}

function Delta({ minutes, suffix = "m" }: { minutes: number; suffix?: string }) {
  return (
    <span
      className={`font-mono num ${minutes < 0 ? "text-emerald-400" : minutes > 0 ? "text-coral" : "text-ink-mute"}`}
    >
      {minutes > 0 ? "+" : ""}
      {minutes.toFixed(1)}
      {suffix}
    </span>
  )
}

/** One `label: value` pair in the stats strip. */
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-ink-mute">{label}:</span> {children}
    </span>
  )
}

/** Header checkbox over the FILTERED set, plus the caret menu beside it. */
function SelectAllHeader({ table }: { table: TanTable<ChangeRow> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  const rows = table.getFilteredRowModel().rows
  const all = rows.length > 0 && rows.every((r) => r.getIsSelected())
  const some = rows.some((r) => r.getIsSelected())
  const pick = (fn: () => void) => {
    fn()
    setOpen(false)
  }
  return (
    <div ref={ref} className="relative flex items-center">
      <input
        type="checkbox"
        className="tbl-check"
        checked={all}
        ref={(el) => {
          if (el) el.indeterminate = !all && some
        }}
        onChange={() => rows.forEach((r) => r.toggleSelected(!all))}
        aria-label="Select all"
      />
      <button
        type="button"
        className="px-0.5 text-ink-mute hover:text-ink"
        onClick={() => setOpen((v) => !v)}
        aria-label="Selection menu"
      >
        <ChevronDown className="h-3 w-3" strokeWidth={2.5} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-44 rounded-md border border-line bg-[#0b1620] py-1 text-[11px] font-normal normal-case tracking-normal shadow-xl shadow-black/40">
          <MenuItem onClick={() => pick(() => rows.forEach((r) => r.toggleSelected(true)))}>
            Select all ({rows.length})
          </MenuItem>
          <MenuItem onClick={() => pick(() => table.toggleAllPageRowsSelected(true))}>
            Select page
          </MenuItem>
          <MenuItem onClick={() => pick(() => table.resetRowSelection())}>
            Clear selection
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="block w-full px-3 py-1.5 text-left text-ink-dim hover:bg-white/[0.05] hover:text-ink"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function ChangesTable({
  rows,
  onRevert,
  headerExtra,
}: {
  rows: ChangeRow[]
  /** Revert these positions in the change list (one for a row ×, many for bulk). */
  onRevert: (indices: number[]) => void
  /** Right end of the stats row, inline after Revert selected — save-as-scenario
   *  lives here. */
  headerExtra?: React.ReactNode
}) {
  const [selected, setSelected] = useState<ChangeRow[]>([])

  // Stats follow the selection: pick some rows and the numbers narrow to them.
  const statRows = selected.length > 0 ? selected : rows
  const sum = (f: (r: ChangeRow) => number | null) =>
    statRows.reduce((n, r) => n + (f(r) ?? 0), 0)
  const kinds = statRows.reduce<Record<string, number>>((acc, r) => {
    const k = kindOf(r)
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {})

  const columns: ColumnDef<ChangeRow>[] = [
    {
      id: "select",
      header: ({ table }) => <SelectAllHeader table={table} />,
      cell: ({ row }) => (
        <input
          type="checkbox"
          className="tbl-check"
          checked={row.getIsSelected()}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => row.toggleSelected(e.target.checked)}
          aria-label="Select row"
        />
      ),
      enableSorting: false,
      // Icon column: sized to its content (checkbox + caret), never scales.
      meta: { widthClass: "w-12" },
    },
    {
      id: "customer",
      accessorFn: (r) => r.customer,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Customer" />,
      cell: ({ row }) => (
        <span className="block truncate text-ink">{row.original.customer}</span>
      ),
      meta: { widthClass: "w-[25%]" },
    },
    {
      id: "office",
      accessorFn: (r) => r.office,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Office" />,
      cell: ({ row }) => (
        <span className="block truncate text-ink-dim">{row.original.office}</span>
      ),
      meta: { widthClass: "w-[13%]" },
    },
    {
      id: "from",
      accessorFn: (r) => sideText(r.fromDay, r.fromTech),
      header: ({ column }) => <DataTableColumnHeader column={column} title="From" />,
      cell: ({ row }) => <Side day={row.original.fromDay} tech={row.original.fromTech} />,
      sortingFn: bySide((r) => [r.fromDay, r.fromTech]),
      filterFn: "equalsString",
      meta: { widthClass: "w-[21%]" },
    },
    {
      id: "arrow",
      header: "",
      cell: () => <span className="text-ink-mute">&rarr;</span>,
      enableSorting: false,
      meta: { widthClass: "w-[4%]" },
    },
    {
      id: "to",
      accessorFn: (r) => sideText(r.toDay, r.toTech),
      header: ({ column }) => <DataTableColumnHeader column={column} title="To" />,
      cell: ({ row }) => <Side day={row.original.toDay} tech={row.original.toTech} />,
      sortingFn: bySide((r) => [r.toDay, r.toTech]),
      filterFn: "equalsString",
      meta: { widthClass: "w-[21%]" },
    },
    {
      id: "cost",
      accessorFn: (r) => r.netMinutes ?? 0,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Cost" />,
      cell: ({ row }) =>
        row.original.netMinutes !== null ? <Delta minutes={row.original.netMinutes} /> : null,
      meta: { align: "right", widthClass: "w-[11%]" },
    },
  ]

  // Facet options for From/To: the distinct day·tech groupings present in the
  // rows, ordered day-first so the dropdown reads like a week.
  const sideOptions = (get: (r: ChangeRow) => [string | null, string | null]) => {
    const seen = new Map<string, [number, string]>()
    for (const r of rows) {
      const [d, t] = get(r)
      const text = sideText(d, t)
      if (!seen.has(text)) {
        const di = d ? DAY_ORDER.indexOf(d) : DAY_ORDER.length
        seen.set(text, [di < 0 ? DAY_ORDER.length : di, t ?? ""])
      }
    }
    return [...seen.entries()]
      .sort((a, b) => a[1][0] - b[1][0] || a[1][1].localeCompare(b[1][1]))
      .map(([v]) => ({ value: v, label: v }))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
        {selected.length > 0 && (
          <span className="font-medium text-cyan">{selected.length} selected</span>
        )}
        <Stat label="min/wk">
          <Delta minutes={sum((r) => r.netMinutes)} suffix="" />
        </Stat>
        <Stat label="mi/wk">
          <Delta minutes={sum((r) => r.netMi)} suffix="" />
        </Stat>
        {Object.entries(kinds).map(([k, n]) => (
          <Stat key={k} label={k}>
            <span className="font-mono num text-ink">{n}</span>
          </Stat>
        ))}
        <span className="flex items-center gap-1.5 pl-2">
          <button
            type="button"
            className="rounded-full border border-coral/40 bg-coral/10 px-2.5 py-0.5 text-[10.5px] font-medium text-coral hover:bg-coral/20 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={selected.length === 0}
            onClick={() => onRevert(selected.map((r) => r.index))}
          >
            Revert selected ({selected.length})
          </button>
          {headerExtra}
        </span>
      </div>
      <DataTable
      columns={columns}
      data={rows}
      searchAccessor={(r) =>
        [r.customer, r.office, r.fromTech, r.toTech, r.fromDay, r.toDay]
          .filter(Boolean)
          .join(" ")
      }
      searchPlaceholder="Search customer, tech, day…"
      facetFilters={[
        { columnId: "office", label: "Office" },
        { columnId: "from", label: "From", options: sideOptions((r) => [r.fromDay, r.fromTech]) },
        { columnId: "to", label: "To", options: sideOptions((r) => [r.toDay, r.toTech]) },
      ]}
      onSelectionChange={setSelected}
      selectOnRowClick
      pageSize={15}
      csvFilename="unpublished-changes"
      emptyText="No unpublished changes."
      embedded
      />
    </div>
  )
}
