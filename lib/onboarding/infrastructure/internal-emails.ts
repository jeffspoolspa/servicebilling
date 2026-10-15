import "server-only"
import { formatPhone } from "@/lib/onboarding/domain"
import { escapeHtml } from "./settings"

/** Staff-facing email bodies (not editable templates). */
const TZ = "America/New_York"

export function easternTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso))
}

/** Midnight today in New York, as a Date (handles EST/EDT). */
export function nyStartOfToday(now = new Date()): Date {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: TZ })
  const utcMidnight = new Date(`${ymd}T00:00:00Z`)
  const asUtc = Date.parse(utcMidnight.toLocaleString("en-US", { timeZone: "UTC" }))
  const asNy = Date.parse(utcMidnight.toLocaleString("en-US", { timeZone: TZ }))
  return new Date(utcMidnight.getTime() + (asUtc - asNy))
}

export function interviewFormUrl(base: string, interviewId: string): string {
  return `${base}/service/onboarding/interview?i=${encodeURIComponent(interviewId)}`
}

interface PreInterviewVars {
  first: string
  last: string
  office: string
  startAt: string
  phone: string | null
  email: string
  formUrl: string
  eventName: string | null
}

export function preInterviewEmail(v: PreInterviewVars): { subject: string; html: string } {
  return {
    subject: `Interview in 15 min: ${v.first} ${v.last} (${v.office})`,
    html:
      `<p><strong>${escapeHtml(v.first)} ${escapeHtml(v.last)}</strong> is interviewing with the ${escapeHtml(v.office)} office.</p>` +
      `<table style="font:14px sans-serif;border-collapse:collapse">` +
      row("Time", easternTime(v.startAt)) +
      row("Phone", formatPhone(v.phone) || "not given") +
      row("Email", v.email) +
      (v.eventName ? row("Calendly event", v.eventName) : "") +
      `</table>` +
      `<p style="margin-top:16px"><a href="${escapeHtml(v.formUrl)}" style="background:#0e7490;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font:600 14px sans-serif">Open the interview form</a></p>` +
      `<p style="color:#666;font:12px sans-serif">The scorecard is required. If the candidate doesn't show, use the No Show button on the form.</p>`,
  }
}

export function scorecardReminderEmail(v: Omit<PreInterviewVars, "eventName">): { subject: string; html: string } {
  return {
    subject: `Scorecard needed: ${v.first} ${v.last} (${v.office})`,
    html:
      `<p>The interview with <strong>${escapeHtml(v.first)} ${escapeHtml(v.last)}</strong> (${escapeHtml(easternTime(v.startAt))}) has no scorecard yet.</p>` +
      `<p>Please submit it now, or mark the candidate as a No Show:</p>` +
      `<p><a href="${escapeHtml(v.formUrl)}">${escapeHtml(v.formUrl)}</a></p>`,
  }
}

function row(k: string, v: string) {
  return `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`
}
