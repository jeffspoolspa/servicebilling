import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listSignOutItems } from "@/lib/entities/inventory-signout"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { SignOutForm } from "./SignOutForm"

export default async function SignOutPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) redirect("/unauthorized")

  const items = await listSignOutItems()
  const name =
    [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
    (employee.employee_code as string | null) ||
    "Tech"

  return <SignOutForm employeeName={name} items={items} />
}
