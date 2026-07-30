/**
 * CSV building — the ONE implementation both table systems use:
 * client DataTable's toolbar download and server-table export routes.
 * BOM-prefixed for Excel; RFC-4180 escaping.
 */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ""
    if (v instanceof Date) return v.toISOString()
    if (typeof v === "object") return JSON.stringify(v)
    return String(v)
  }
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return (
    "﻿" +
    [header, ...rows.map((r) => r.map(cell))].map((r) => r.map(esc).join(",")).join("\r\n")
  )
}
