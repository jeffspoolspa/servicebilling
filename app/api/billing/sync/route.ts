import { NextResponse } from "next/server"
import { triggerScript } from "@/lib/windmill"

export async function POST() {
  // Run invoices + credits + payment methods in parallel
  const [invoices, credits, paymentMethods] = await Promise.all([
    triggerScript("f/service_billing/pull_qbo_invoices"),
    triggerScript("f/service_billing/pull_qbo_credits"),
    triggerScript("f/service_billing/pull_customer_payment_methods"),
  ])

  return NextResponse.json({
    status: "triggered",
    jobs: {
      invoices: invoices.jobId,
      credits: credits.jobId,
      paymentMethods: paymentMethods.jobId,
    },
  })
}
