import type { Metadata } from "next"
import { onboardingDb } from "@/lib/onboarding/infrastructure/db"
import { resolveUploadToken } from "@/lib/onboarding/application/upload-tokens"
import { docsForToken } from "@/lib/onboarding/application/submit-documents"
import { UploadForm } from "./upload-form"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Upload hiring documents · Jeff's Pool & Spa", robots: { index: false, follow: false } }

/**
 * /service/onboarding/upload/<token> — candidate-facing, no login (the
 * session wall skips this path; see lib/supabase/middleware.ts). Lives in
 * its own route group so the staff layout never wraps it.
 */
export default async function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const st = await resolveUploadToken(onboardingDb(), token)

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 [font-size:16px]">
      <div className="max-w-xl mx-auto px-4 py-6 sm:py-10">
        <div className="text-[13px] font-semibold tracking-wide text-sky-700 uppercase">Jeff&apos;s Pool &amp; Spa</div>
        {!st.ok ? (
          <div className="mt-4 bg-white rounded-xl border border-slate-200 p-5">
            <h1 className="text-xl font-semibold">
              {st.reason === "used" ? "Documents already received" : st.reason === "expired" ? "This link has expired" : "This link isn't valid"}
            </h1>
            <p className="mt-2 text-slate-600">
              {st.reason === "used"
                ? "Thanks, we already have your documents. We'll be in touch."
                : "Please contact the office that interviewed you and ask for a new upload link."}
            </p>
          </div>
        ) : (
          <UploadForm
            token={token}
            firstName={st.candidate.first_name}
            purpose={st.token.purpose}
            docs={docsForToken(st.token)}
            note={st.token.note}
          />
        )}
      </div>
    </div>
  )
}
