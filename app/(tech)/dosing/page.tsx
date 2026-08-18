import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listActiveCustomers } from "@/lib/entities/follow-up"
import { canUseTechApp } from "@/lib/auth/tech-app"
import { usesOfflineDosing } from "@/lib/auth/tech-scope"
import { DosingForm } from "./DosingForm"

export default async function DosingPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (!(await canUseTechApp(employee))) redirect("/unauthorized")

  // RH/Savannah (plus named individuals) run the standalone offline
  // calculator instead of the API-backed pour sheet (ruled 2026-08-18).
  // Same tab, different tool — the iframe keeps them inside the app shell
  // so the bottom nav stays.
  if (await usesOfflineDosing(employee)) {
    return (
      <iframe
        src="/dosing/offline.html"
        title="Field Dosing Calculator"
        className="w-full rounded-xl border border-line-soft bg-white"
        style={{ height: "calc(100dvh - 180px)" }}
      />
    )
  }

  const customers = await listActiveCustomers()
  return <DosingForm customers={customers} />
}
