import { notFound } from "next/navigation"
import { CreditCard } from "lucide-react"
import { ObjectHeader } from "@/components/shell/object-header"
import { BackButton } from "@/components/shell/back-button"
import { requireModuleWrite } from "@/lib/auth/access"
import { createSupabaseAdmin } from "@/lib/supabase/admin"
import { OnboardingForm, type OnboardingLead } from "./onboarding-form"

export const dynamic = "force-dynamic"

const CARD_VAULT_URL = process.env.NEXT_PUBLIC_CARD_VAULT_URL || "https://secure.jeffspoolspa.com"

export default async function LeadOnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModuleWrite("leads")
  const { id } = await params
  const sb = createSupabaseAdmin()

  const { data: lead, error } = await sb.rpc("get_maintenance_lead_detail", { p_lead_id: id })
  if (error || !lead) notFound()
  const l = lead as OnboardingLead

  // The card-vault pre-authorizes (holds, not captures) the first-month deposit.
  // Prefer the stored deposit; else derive labor-monthly from the quote.
  const depositDollars =
    Number(l.first_months_deposit) ||
    (l.quoted_per_visit && l.visits_per_week ? Number(l.quoted_per_visit) * Number(l.visits_per_week) * 4 : 0)
  const preAuthCents = depositDollars > 0 ? Math.round(depositDollars * 100) : null

  // Card collection needs the customer to exist in QBO (the vault posts to
  // QBO /customers/{id}/cards). If the Pattern-D create is still propagating,
  // qbo_customer_id is null — surface that instead of a broken iframe.
  const qboReady = !!l.qbo_customer_id

  let cardToken: string | null = null
  let tokenError: string | null = null
  if (qboReady) {
    const { data: tok, error: tokErr } = await sb.rpc("create_card_collection_request", {
      p_lead_id: id,
      p_pre_auth_amount: preAuthCents,
    })
    if (tokErr) tokenError = tokErr.message
    else {
      const res = tok as Record<string, unknown> | null
      if (res?.error) tokenError = String(res.error)
      else cardToken = (res?.token as string) ?? null
    }
  }

  const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || "Customer"

  return (
    <>
      <ObjectHeader
        eyebrow="Onboarding"
        title={name}
        sub="Collect the card, then confirm pool details — converts the lead on the spot."
        icon={<CreditCard />}
        actions={<BackButton fallbackHref={`/leads/${id}`} />}
      />
      <div className="px-7 py-6">
        <OnboardingForm
          leadId={id}
          lead={l}
          cardToken={cardToken}
          cardVaultUrl={CARD_VAULT_URL}
          depositDollars={depositDollars}
          qboReady={qboReady}
          tokenError={tokenError}
        />
      </div>
    </>
  )
}
