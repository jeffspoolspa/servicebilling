/** Mon..Fri days in [fromIso, toIsoExclusive). No holiday calendar. */
export function workdays(fromIso: string, toIsoExclusive: string): number {
  let n = 0
  const d = new Date(fromIso + "T00:00:00Z")
  const end = new Date(toIsoExclusive + "T00:00:00Z")
  while (d < end) {
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) n++
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return n
}

export function nextDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
