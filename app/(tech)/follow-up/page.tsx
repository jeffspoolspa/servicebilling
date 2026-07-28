import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listActiveCustomers } from "@/lib/entities/follow-up"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { FollowUpForm } from "./FollowUpForm"

export default async function FollowUpPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) redirect("/unauthorized")

  const customers = await listActiveCustomers()
  const name =
    [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
    (employee.employee_code as string | null) ||
    "Tech"

  return (
    <FollowUpForm
      techName={name}
      authUserId={employee.auth_user_id as string}
      customers={customers}
    />
  )
}
