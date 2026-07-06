"use client"

import * as React from "react"
import {
  ColumnDef,
  ColumnFiltersState,
  Row,
  SortingState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type Table as TanTable,
  type VisibilityState,
} from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils/cn"

/**
 * The app's TanStack data table (shadcn data-table pattern, app tokens).
 * Client-side sorting / filtering / pagination / selection / expansion over
 * server-fetched data — pages fetch per month, the table owns interaction
 * state. Compose with DataTableColumnHeader in column defs; pass facet
 * filters to get the select-dropdown toolbar; searchAccessor enables the
 * global search input.
 */

export interface FacetFilter<TData> {
  columnId: string
  label: string
  /** Options; omit to derive from the column's unique values. */
  options?: { value: string; label: string }[]
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  /** Row string for the global search input; omit to hide search. */
  searchAccessor?: (row: TData) => string
  searchPlaceholder?: string
  facetFilters?: FacetFilter<TData>[]
  /** Right side of the toolbar (action buttons etc.). */
  toolbarExtra?: React.ReactNode
  pageSize?: number
  initialSorting?: SortingState
  emptyText?: string
  /** Selection: rows of the CURRENT filtered set the user has checked. */
  onSelectionChange?: (rows: TData[]) => void
  /** Expansion: render an expanded panel row under a clicked row. */
  renderSubRow?: (row: Row<TData>) => React.ReactNode
  rowClassName?: (row: Row<TData>) => string | undefined
  /** Hide columns that exist only to power facet filters. */
  columnVisibility?: VisibilityState
}

export function DataTable<TData, TValue>({
  columns,
  data,
  searchAccessor,
  searchPlaceholder = "Search…",
  facetFilters,
  toolbarExtra,
  pageSize = 25,
  initialSorting = [],
  emptyText = "No rows.",
  onSelectionChange,
  renderSubRow,
  rowClassName,
  columnVisibility,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting)
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = React.useState("")
  const [rowSelection, setRowSelection] = React.useState({})
  const [expanded, setExpanded] = React.useState({})

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection, expanded },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    globalFilterFn: (row, _columnId, filterValue) => {
      if (!searchAccessor) return true
      return searchAccessor(row.original)
        .toLowerCase()
        .includes(String(filterValue).toLowerCase())
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getRowCanExpand: renderSubRow ? () => true : undefined,
    getExpandedRowModel: renderSubRow ? getExpandedRowModel() : undefined,
    autoResetPageIndex: false,
    initialState: { pagination: { pageSize }, columnVisibility: columnVisibility ?? {} },
  })

  // surface selection to the parent (filtered set only)
  const selectedRows = table.getFilteredSelectedRowModel().rows
  const onSelectionChangeRef = React.useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const selectedKey = selectedRows.map((r) => r.id).join(",")
  React.useEffect(() => {
    onSelectionChangeRef.current?.(selectedRows.map((r) => r.original))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const hasToolbar = searchAccessor || (facetFilters?.length ?? 0) > 0 || toolbarExtra

  return (
    <div className="space-y-3">
      {hasToolbar && (
        <div className="flex items-center gap-2 flex-wrap">
          {searchAccessor && (
            <div className="relative inline-flex items-center w-56">
              <Search
                className="absolute left-2.5 w-3.5 h-3.5 pointer-events-none text-ink-mute"
                strokeWidth={2}
              />
              <input
                type="search"
                value={globalFilter}
                onChange={(e) => {
                  setGlobalFilter(e.target.value)
                  table.setPageIndex(0)
                }}
                placeholder={searchPlaceholder}
                spellCheck={false}
                className="w-full bg-[#0E1C2A] border border-line rounded-md pl-7 pr-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
              />
            </div>
          )}
          {facetFilters?.map((f) => (
            <FacetSelect key={f.columnId} table={table} filter={f} />
          ))}
          {toolbarExtra && <div className="ml-auto flex items-center gap-2">{toolbarExtra}</div>}
        </div>
      )}

      <div className="bg-bg-elev border border-line rounded-lg shadow-card overflow-hidden">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      "px-4 py-2 text-ink-mute font-medium",
                      (header.column.columnDef.meta as ColumnMeta | undefined)?.align ===
                        "right" && "text-right",
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <React.Fragment key={row.id}>
                  <TableRow
                    data-state={row.getIsSelected() && "selected"}
                    className={cn(
                      "border-line-soft/40 hover:bg-white/[0.02]",
                      renderSubRow && "cursor-pointer",
                      rowClassName?.(row),
                    )}
                    onClick={renderSubRow ? () => row.toggleExpanded() : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "px-4 py-2.5",
                          (cell.column.columnDef.meta as ColumnMeta | undefined)?.align ===
                            "right" && "text-right",
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                  {row.getIsExpanded() && renderSubRow && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={row.getVisibleCells().length} className="p-0">
                        {renderSubRow(row)}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-20 text-center text-ink-mute"
                >
                  {emptyText}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination table={table} />
    </div>
  )
}

interface ColumnMeta {
  align?: "left" | "right"
}

/** Sortable column header — asc/desc toggle with direction indicator. */
export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: {
  column: Column<TData, TValue>
  title: string
  className?: string
}) {
  if (!column.getCanSort()) {
    return <span className={className}>{title}</span>
  }
  const sorted = column.getIsSorted()
  return (
    <button
      type="button"
      onClick={() => column.toggleSorting(sorted === "asc")}
      className={cn(
        "inline-flex items-center gap-1 cursor-pointer transition-colors",
        sorted ? "text-ink" : "text-ink-mute hover:text-ink",
        className,
      )}
    >
      <span>{title}</span>
      {sorted === "asc" ? (
        <ArrowUp className="w-3 h-3" strokeWidth={2.5} />
      ) : sorted === "desc" ? (
        <ArrowDown className="w-3 h-3" strokeWidth={2.5} />
      ) : (
        <ChevronsUpDown className="w-3 h-3 opacity-30" strokeWidth={2} />
      )}
    </button>
  )
}

/** Select-dropdown facet filter, styled like the WO filter bar. */
function FacetSelect<TData>({
  table,
  filter,
}: {
  table: TanTable<TData>
  filter: FacetFilter<TData>
}) {
  const column = table.getColumn(filter.columnId)
  if (!column) return null
  const value = (column.getFilterValue() as string) ?? ""
  const options =
    filter.options ??
    [...column.getFacetedUniqueValues().keys()]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .sort()
      .map((v) => ({ value: v, label: v }))
  return (
    <div className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => {
          column.setFilterValue(e.target.value || undefined)
          table.setPageIndex(0)
        }}
        className={cn(
          "appearance-none bg-bg-elev border rounded-md pl-2.5 pr-6 py-1.5 text-[12px] focus:outline-none transition-colors cursor-pointer",
          value ? "border-cyan/40 text-cyan" : "border-line text-ink-dim hover:border-line/80",
        )}
      >
        <option value="">{filter.label}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {value ? (
        <button
          type="button"
          onClick={() => column.setFilterValue(undefined)}
          className="absolute right-1.5 text-cyan/70 hover:text-cyan"
          aria-label={`Clear ${filter.label}`}
        >
          <X className="w-3 h-3" strokeWidth={2.5} />
        </button>
      ) : (
        <span className="pointer-events-none absolute right-2 text-ink-mute text-[9px]">▼</span>
      )}
    </div>
  )
}

/** Pagination controls: selected count, page size, page nav. */
export function DataTablePagination<TData>({ table }: { table: TanTable<TData> }) {
  const selected = table.getFilteredSelectedRowModel().rows.length
  const total = table.getFilteredRowModel().rows.length
  const { pageIndex, pageSize } = table.getState().pagination
  const pageCount = table.getPageCount()
  if (total === 0) return null
  return (
    <div className="flex items-center justify-between gap-4 text-[11px] text-ink-mute">
      <div>
        {selected > 0 && <span className="text-ink">{selected} selected · </span>}
        {total.toLocaleString()} row{total === 1 ? "" : "s"}
      </div>
      {pageCount > 1 && (
        <div className="flex items-center gap-3">
          <span>
            {pageIndex * pageSize + 1}–{Math.min((pageIndex + 1) * pageSize, total)} of{" "}
            {total.toLocaleString()}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="px-2.5 py-1 rounded border border-line text-ink-dim hover:text-ink hover:border-line/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="px-2.5 py-1 rounded border border-line text-ink-dim hover:text-ink hover:border-line/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
