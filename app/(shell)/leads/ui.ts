/** Shared display helpers for the /leads module (pure — safe in server + client). */

type Tone = "neutral" | "cyan" | "teal" | "sun" | "coral" | "grass" | "indigo"

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case "new": return "neutral"
    case "quoted": return "cyan"
    case "accepted": return "sun"
    case "converted": return "grass"
    case "expired":
    case "declined":
    case "disqualified":
    case "closed": return "coral"
    default: return "neutral"
  }
}

const OFFICE_LABELS: Record<string, string> = {
  richmond_hill: "Richmond Hill",
  brunswick: "Brunswick",
  st_marys: "St. Marys",
}

export function prettyOffice(office: string | null | undefined): string {
  if (!office) return "—"
  return OFFICE_LABELS[office] ?? office
}
