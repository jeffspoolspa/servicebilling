// Per-office routing + branding for outbound comms.

import type { Office } from "./types"

// ── Email (Resend) ─────────────────────────────────────────────────────────
// All offices send from a single shared marketing domain
// (jeffspoolspasales.com). Brand identity comes through the From display
// name. Replies route to the office's monitored inbox via Reply-To, and the
// office address is BCC'd on every send so the team has a copy in their
// own inbox (preserves Gmail-sent-folder-style visibility without exposing
// internal addresses to the recipient).
//
// Resend requires jeffspoolspasales.com to be a verified sending domain
// (SPF + DKIM records added in Resend's Domains UI). Reply-To and BCC
// addresses don't need verification — they're just headers.

export interface EmailOfficeBranding {
  from_name: string
  from_address: string
  reply_to: string
  auto_bcc: readonly string[]
}

const SHARED_FROM_ADDRESS = "quotes@jeffspoolspasales.com"

export const EMAIL_OFFICE_BRANDING: Record<Office, EmailOfficeBranding> = {
  richmond_hill: {
    from_name: "Perfect Pools",
    from_address: SHARED_FROM_ADDRESS,
    reply_to: "info@perfectpoolscleaning.com",
    auto_bcc: ["info@perfectpoolscleaning.com"],
  },
  brunswick: {
    from_name: "Jeff's Pool & Spa Service",
    from_address: SHARED_FROM_ADDRESS,
    reply_to: "jpsbilling@jeffspoolspa.com",
    auto_bcc: ["jpsbilling@jeffspoolspa.com"],
  },
  st_marys: {
    from_name: "Jeff's Pool & Spa Service",
    from_address: SHARED_FROM_ADDRESS,
    reply_to: "jpsbilling@jeffspoolspa.com",
    auto_bcc: ["jpsbilling@jeffspoolspa.com"],
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
