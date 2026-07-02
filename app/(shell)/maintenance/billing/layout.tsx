import { Suspense } from "react"
import { BillingStageTabs } from "./billing-stage-tabs"

/**
 * Shared layout for /maintenance/billing/*: the stage tabs of the monthly
 * billing workflow (Bills -> Needs Review -> Ready to Process, + the Autopay
 * roster). Access is guarded by the parent maintenance layout.
 */
export default function MaintenanceBillingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <Suspense fallback={null}>
        <BillingStageTabs />
      </Suspense>
      {children}
    </>
  )
}
