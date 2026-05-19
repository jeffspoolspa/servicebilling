// Per-office routing + branding for outbound comms.

import type { Office } from "./types"

// ── Email (Resend) ─────────────────────────────────────────────────────────
// Each office sends from a brand-appropriate domain. Replies route back to a
// monitored inbox per office. Resend requires the FROM domain to be verified
// in your Resend account before sends succeed.

export interface EmailOfficeBranding {
  from_name: string
  from_address: string
  reply_to: string
  auto_cc: readonly string[]
}

export const EMAIL_OFFICE_BRANDING: Record<Office, EmailOfficeBranding> = {
  richmond_hill: {
    from_name: "Perfect Pools",
    from_address: "quotes@perfectpoolscleaning.com",
    reply_to: "info@perfectpoolscleaning.com",
    auto_cc: ["info@perfectpoolscleaning.com"],
  },
  brunswick: {
    from_name: "Jeff's Pool & Spa Service",
    from_address: "quotes@jeffspoolspa.com",
    reply_to: "jpsbilling@jeffspoolspa.com",
    auto_cc: [],
  },
  st_marys: {
    from_name: "Jeff's Pool & Spa Service",
    from_address: "quotes@jeffspoolspa.com",
    reply_to: "jpsbilling@jeffspoolspa.com",
    auto_cc: [],
  },
}

// ── SMS (RingCentral) ──────────────────────────────────────────────────────

export interface RcOfficeConfig {
  from_number: string
  jwt_env: "RC_JWT_PP" | "RC_JWT_USER"
}

export const RC_OFFICE_CONFIG: Record<Office, RcOfficeConfig> = {
  richmond_hill: { from_number: "+19124590160", jwt_env: "RC_JWT_PP" },
  brunswick: { from_number: "+19125540636", jwt_env: "RC_JWT_USER" },
  st_marys: { from_number: "+19125540636", jwt_env: "RC_JWT_USER" },
}
