/** Hard-coded IDs we refer to across the tech/admin surface. */
export const MAINTENANCE_DEPARTMENT_ID = "757659e3-d73f-48c3-999f-6f071f1e3587"

/**
 * Domain used for synthetic auth emails for maintenance techs. These emails
 * are never sent mail — they're opaque IDs derived from a tech_username so
 * Supabase's email/password backend can be used without exposing email UX
 * to techs.
 */
export const TECH_EMAIL_DOMAIN = "techs.jeffspoolspa.internal"

export function usernameToSyntheticEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${TECH_EMAIL_DOMAIN}`
}

export function isTechUsername(raw: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/i.test(raw)
}
