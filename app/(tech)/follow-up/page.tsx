import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listActiveCustomers } from "@/lib/entities/follow-up"
import { canUseTechApp } from "@/lib/auth/tech-app"
import { FollowUpForm } from "./FollowUpForm"

export default async function FollowUpPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (!(await canUseTechApp(employee))) redirect("/unauthorized")

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
