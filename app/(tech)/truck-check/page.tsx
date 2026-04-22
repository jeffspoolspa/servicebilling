import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listSignOutItems } from "@/lib/entities/inventory-signout"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { TruckCheckList } from "./TruckCheckList"

export default async function TruckCheckPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) redirect("/unauthorized")

  const items = await listSignOutItems()

  return <TruckCheckList items={items} storageKey={`truck-check:${employee.id}`} />
}
