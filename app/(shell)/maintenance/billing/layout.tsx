/**
 * Shared layout for /maintenance/billing/*. RULED: no stage tabs — the
 * billing module is ONE view (the months table with a month picker) and its
 * per-month detail. Legacy pipeline pages remain routable but unlinked.
 * Access is guarded by the parent maintenance layout.
 */
export default function MaintenanceBillingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
