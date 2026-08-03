import { redirect } from "next/navigation"

/** The months table IS the billing landing now — keep old links working. */
export default async function MonthsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const { month } = await searchParams
  redirect((`/maintenance/billing${month ? `?month=${month}` : ""}`) as never)
}
