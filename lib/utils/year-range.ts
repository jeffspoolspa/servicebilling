/** Jan 1 of `year` to Jan 1 of the next, as the pivot's [startMonth, endMonth). */
export function yearRange(year: number): { startMonth: string; endMonth: string } {
  return { startMonth: `${year}-01-01`, endMonth: `${year + 1}-01-01` }
}
