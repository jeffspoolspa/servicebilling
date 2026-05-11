export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "—"
  // YYYY-MM-DD strings from Postgres DATE columns have no time/tz.
  // new Date("2026-05-07") interprets that as UTC midnight; Intl then
  // renders in the user's local tz, shifting the day by one for
  // negative-UTC offsets (EST/CST/PST). Pin to UTC formatting for the
  // calendar-date case so May 7 stays May 7 regardless of viewer tz.
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`))
  }
  const d = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d)
}

export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return "—"
  const d = typeof date === "string" ? new Date(date) : date
  const diff = Date.now() - d.getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(d)
}
