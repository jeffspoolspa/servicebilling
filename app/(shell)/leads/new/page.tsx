import { UserPlus } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card } from "@/components/ui/card"
import { BackButton } from "@/components/shell/back-button"
import { requireModuleWrite } from "@/lib/auth/access"
import { NewLeadForm } from "./new-lead-form"

export const dynamic = "force-dynamic"

export default async function NewLeadPage() {
  await requireModuleWrite("leads")
  return (
    <>
      <ObjectHeader
        eyebrow="Pipeline"
        title="New lead"
        sub="Enter a phoned-in or walk-in maintenance lead — same pipeline as the website."
        icon={<UserPlus />}
        actions={<BackButton fallbackHref="/leads" />}
      />
      <div className="px-7 py-6 max-w-2xl">
        <Card>
          <div className="p-5">
            <NewLeadForm />
          </div>
        </Card>
      </div>
    </>
  )
}
