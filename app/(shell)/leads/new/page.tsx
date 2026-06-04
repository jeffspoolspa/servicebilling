import { UserPlus } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { BackButton } from "@/components/shell/back-button"
import { requireModuleWrite } from "@/lib/auth/access"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { NewLeadForm, type ChemEstimates } from "./new-lead-form"

export const dynamic = "force-dynamic"

/** Current-month chemical estimate per service frequency (public.chemical_cost_estimates). */
async function getChemEstimates(): Promise<ChemEstimates | null> {
  const month = new Date().getMonth() + 1
  const sb = createSupabaseAdmin()
  const { data, error } = await sb
    .from("chemical_cost_estimates")
    .select("service_frequency, chem_median, chem_p25, chem_p75")
    .eq("calendar_month", month)
  if (error || !data) return null
  const pick = (freq: string) => {
    const r = data.find((d) => d.service_frequency === freq)
    return r ? { med: Math.round(Number(r.chem_median)), low: Math.round(Number(r.chem_p25)), high: Math.round(Number(r.chem_p75)) } : null
  }
  const weekly = pick("weekly")
  const biweekly = pick("biweekly")
  if (!weekly || !biweekly) return null
  return { weekly, biweekly }
}

export default async function NewLeadPage() {
  await requireModuleWrite("leads")
  const chem = await getChemEstimates()
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
