import Link from "next/link"
import { UserRoundCheck } from "lucide-react"
import { requireOnboardingStaff } from "@/lib/onboarding/infrastructure/staff-guard"

export const dynamic = "force-dynamic"

/**
 * Candidate Onboarding shell. Lives in its own route group so it is NOT
 * behind the Service module guard (app/(shell)/service/layout.tsx): access
 * is the onboarding staff allowlist, independent of app_roles. Login itself
 * is the app's existing email/password login, unchanged.
 *
 * The candidate upload page (P2) sits outside this layout: no login.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const me = await requireOnboardingStaff()
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line-soft bg-bg-elev/60 backdrop-blur sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-7 h-12 flex items-center gap-4">
          <Link href="/service/onboarding/interview" className="flex items-center gap-2 text-ink">
            <span className="w-7 h-7 rounded-md bg-cyan/10 border border-cyan/20 grid place-items-center text-cyan">
              <UserRoundCheck className="w-4 h-4" strokeWidth={1.8} />
            </span>
            <span className="font-display text-[15px] tracking-tight">Candidate Onboarding</span>
          </Link>
          <nav className="flex items-center gap-1 text-[13px]">
            <Link href="/service/onboarding/interview" className="px-2.5 py-1 rounded-md text-ink-dim hover:text-ink hover:bg-white/5">
              Interview Form
            </Link>
            <Link href="/service/onboarding/candidates" className="px-2.5 py-1 rounded-md text-ink-dim hover:text-ink hover:bg-white/5">
              Candidates
            </Link>
            {me.staff.is_admin && (
              <Link href="/service/onboarding/setup" className="px-2.5 py-1 rounded-md text-ink-dim hover:text-ink hover:bg-white/5">
                Setup
              </Link>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-[12px] text-ink-mute">
            <span className="hidden sm:inline">{me.staff.name}</span>
            <a href="/logout" className="hover:text-ink">Sign out</a>
          </div>
        </div>
      </header>
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-7 py-6">{children}</main>
    </div>
  )
}
