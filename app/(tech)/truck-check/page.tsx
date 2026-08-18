import { redirect } from "next/navigation"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listSignOutItems } from "@/lib/entities/inventory-signout"
import { canUseTechApp } from "@/lib/auth/tech-app"
import { isFollowUpOnly } from "@/lib/auth/tech-scope"
import { TruckCheckList } from "./TruckCheckList"

export default async function TruckCheckPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (!(await canUseTechApp(employee))) redirect("/unauthorized")
  if (await isFollowUpOnly(employee)) redirect("/follow-up")

  const items = await listSignOutItems()

  return (
    <TruckCheckList
      items={items}
      storageKey={`truck-check:${employee.id}`}
      completedStorageKey={`truck-check-completed:${employee.id}`}
    />
  )
}
