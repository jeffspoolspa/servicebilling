import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listActiveCustomers } from "@/lib/entities/follow-up"
import { canUseTechApp } from "@/lib/auth/tech-app"
import { DosingForm } from "./DosingForm"

export default async function DosingPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (!(await canUseTechApp(employee))) redirect("/unauthorized")

  const customers = await listActiveCustomers()
  return <DosingForm customers={customers} />
}
