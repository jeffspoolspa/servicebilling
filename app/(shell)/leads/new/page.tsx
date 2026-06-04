import { UserPlus } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { BackButton } from "@/components/shell/back-button"
import { requireModuleWrite } from "@/lib/auth/access"
import { estimateMaintChemicals } from "@/lib/leads/chem-estimate"
import { NewLeadForm } from "./new-lead-form"

export const dynamic = "force-dynamic"

export default async function NewLeadPage() {
  await requireModuleWrite("leads")
  // Preload the current-month chemical tiers once; the form computes the live
  // quote client-side from this bundle via calculateMaintQuote (no per-keystroke network).
  const chem = await estimateMaintChemicals()
  return (
    <>
      <ObjectHeader
        eyebrow="Pipeline"
        title="New lead"
        sub="Enter a phoned-in or walk-in maintenance lead — same pipeline as the website."
        icon={<UserPlus />}
        actions={<BackButton fallbackHref="/leads" />}
      />
      <div className="px-7 py-6">
        <NewLeadForm chem={chem} />
      </div>
    </>
  )
}
