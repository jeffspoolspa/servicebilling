import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listActiveCustomers } from "@/lib/entities/follow-up"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { DosingForm } from "./DosingForm"

export default async function DosingPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) redirect("/unauthorized")

  const customers = await listActiveCustomers()
  return <DosingForm customers={customers} />
}
