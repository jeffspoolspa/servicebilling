/**
 * Hiring documents: what the candidate uploads, the details form rules,
 * and the driver acceptability criteria reviewers check against.
 */
export const UPLOAD_DOC_TYPES = ["MVR", "Drivers License", "Criminal History"] as const
export type UploadDocType = (typeof UPLOAD_DOC_TYPES)[number]

export type UploadSlot = "mvr" | "dl_front" | "dl_back" | "criminal"
export const SLOT_DOC_TYPE: Record<UploadSlot, UploadDocType> = {
  mvr: "MVR",
  dl_front: "Drivers License",
  dl_back: "Drivers License",
  criminal: "Criminal History",
}
export const SLOTS_FOR_DOC: Record<UploadDocType, UploadSlot[]> = {
  MVR: ["mvr"],
  "Drivers License": ["dl_front", "dl_back"],
  "Criminal History": ["criminal"],
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const REVIEW_EMAIL_MAX_BYTES = 20 * 1024 * 1024

/** Whole years between dob and `on` (both YYYY-MM-DD). */
export function ageOn(dobIso: string, onIso: string): number {
  const [y, m, d] = dobIso.split("-").map(Number)
  const [oy, om, od] = onIso.split("-").map(Number)
  let age = oy - y
  if (om < m || (om === m && od < d)) age--
  return age
}

export interface UploadDetails {
  legalFirst: string
  legalLast: string
  dob: string
  dlState: string
  dlNumber: string
  dlExpires: string
  /** "I have had a driver's license for at least 3 years" (reviewer verifies on the MVR). */
  licensed3Years: boolean
}

/** Problems that block submission. Under-21 etc. are reviewer decisions, not blocks. */
export function detailProblems(d: UploadDetails, todayIso: string): string[] {
  const p: string[] = []
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
  if (!d.legalFirst.trim() || !d.legalLast.trim()) p.push("Enter your legal first and last name.")
  if (!isDate(d.dob) || d.dob >= todayIso) p.push("Enter a valid date of birth.")
  if (d.dlState !== "GA") p.push("We can only accept a Georgia driver's license.")
  if (!/^\d{7,9}$/.test(d.dlNumber.replace(/\s|-/g, ""))) p.push("Enter your Georgia license number (7 to 9 digits).")
  if (!isDate(d.dlExpires)) p.push("Enter your license expiration date.")
  else if (d.dlExpires < todayIso) p.push("Your license is expired. We need a valid Georgia license.")
  return p
}

/** Unacceptable-driver criteria (carrier sheet 5-R-361 + company rules), shown on the review page. */
export const DRIVER_CRITERIA: { heading: string; items: string[] }[] = [
  {
    heading: "Any Type A violation on the MVR",
    items: [
      "Distracted driving (cell phone, texting, talking)",
      "DUI/DWI/OUI/OWI (drugs or alcohol); refusing a substance test; open container",
      "Driving with a suspended or revoked license; permitting an unlicensed person to drive",
      "Reckless driving; speed contest (racing); fleeing or evading police; resisting arrest",
      "Hit and run; failure to report an accident; illegal passing of a school bus",
      "Vehicular manslaughter or homicide; aggravated assault with a vehicle; felony committed with a vehicle",
      "Other serious violations",
    ],
  },
  {
    heading: "Other disqualifiers",
    items: [
      "3 or more Type B violations in the past 3 years (speeding, failure to yield, improper lane change, careless driving, failure to obey a signal or sign, at-fault accidents)",
      "Under 21",
      "Licensed less than 3 years, regardless of age",
      "Only an international or foreign license",
      "Not licensed in the state of residence",
      "License cancelled, revoked, suspended or expired",
      "Company rule: any Georgia \"super speeder\" citation",
      "Company rule: Georgia license required",
      "Drivers over 65 need a physician statement",
      "The MVR must cover 3 years",
    ],
  },
]
