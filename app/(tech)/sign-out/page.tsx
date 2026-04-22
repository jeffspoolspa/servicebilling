import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import {
  listSignOutItems,
  listTodaysSignOuts,
} from "@/lib/entities/inventory-signout"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { SignOutForm } from "./SignOutForm"
import { TodayList } from "./TodayList"
import { SignOutTabs } from "./SignOutTabs"

interface Props {
  searchParams: Promise<{ prefill?: string }>
}

export default async function SignOutPage({ searchParams }: Props) {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) redirect("/unauthorized")

  const [items, todaysRows, { prefill }] = await Promise.all([
    listSignOutItems(),
    listTodaysSignOuts(),
    searchParams,
  ])
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

  return (
    <SignOutTabs
      todayCount={todaysRows.length}
      newPane={<SignOutForm employeeName={name} items={items} prefillIds={validPrefill} />}
      todayPane={<TodayList rows={todaysRows} />}
    />
  )
}
