import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listSignOutItems } from "@/lib/entities/inventory-signout"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { SignOutForm } from "./SignOutForm"

interface Props {
  searchParams: Promise<{ prefill?: string }>
}

export default async function SignOutPage({ searchParams }: Props) {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) redirect("/unauthorized")

  const [items, { prefill }] = await Promise.all([listSignOutItems(), searchParams])
  const name =
    [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
    (employee.employee_code as string | null) ||
    "Tech"

  const prefillIds =
    (prefill ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0) ?? []
  const allowed = new Set(items.map((i) => i.id))
  const validPrefill = prefillIds.filter((id) => allowed.has(id))

  return <SignOutForm employeeName={name} items={items} prefillIds={validPrefill} />
}
