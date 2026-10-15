/**
 * Interview scorecard scoring rules.
 *
 *   overall = mean of the six 1-5 ratings, rounded to 1 decimal
 *   grade   = A >= 4.5, B >= 3.75, C >= 3.0, D >= 2.25, F below
 *            (graded on the rounded score staff see)
 */
export const RATING_KEYS = [
  "professionalism",
  "presentation",
  "communication",
  "interest",
  "experience",
  "essential_functions",
] as const
export type RatingKey = (typeof RATING_KEYS)[number]
export type Ratings = Record<RatingKey, number>

export interface RatingSpec {
  key: RatingKey
  label: string
  help?: string
  /** Anchor text for 1, 3 and 5. */
  anchors: [string, string, string]
}

export const RATING_SPECS: RatingSpec[] = [
  {
    key: "professionalism",
    label: "Professionalism",
    anchors: ["Rude or dismissive", "Courteous", "Respectful, mature, takes it seriously"],
  },
  {
    key: "presentation",
    label: "Professional presentation",
    help: "Punctual, dressed for the job.",
    anchors: ["Late / unprepared", "On time, presentable", "Early, dressed for the work"],
  },
  {
    key: "communication",
    label: "Communication skills",
    anchors: ["Hard to follow", "Clear enough", "Clear, listens, good with customers"],
  },
  {
    key: "interest",
    label: "Genuine interest in the position",
    anchors: ["Just needs any job", "Interested", "Asked good questions, wants this work"],
  },
  {
    key: "experience",
    label: "Prior relevant work experience",
    anchors: ["None", "Some outdoor / hands-on work", "Pool, service or trade experience"],
  },
  {
    key: "essential_functions",
    label: "Ability to perform the essential functions",
    help:
      "Lift 50 lb, work outdoors in heat, climb ladders and work on equipment pads, with or without reasonable accommodation. Rate what the candidate says; don't rate from appearance.",
    anchors: ["Says they can't", "Some concerns stated", "Confirms they can do all of it"],
  },
]

export type Grade = "A" | "B" | "C" | "D" | "F"
export type Recommendation = "hire" | "no_hire" | "follow_up"

export const PAY_RATES = [14, 15, 16] as const
export type PayRate = (typeof PAY_RATES)[number]
export const DEFAULT_PAY_RATE: PayRate = 14
export const PAY_RATE_NOTE = "Training wage. +$1/hr on passing training; +$1/hr when covering own route."

export function isRating(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5
}

/** Mean of the six ratings to one decimal. Throws if any rating is missing. */
export function overallScore(r: Ratings): number {
  const vals = RATING_KEYS.map((k) => r[k])
  if (!vals.every(isRating)) throw new Error("every rating must be an integer 1-5")
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  // Round half up at one decimal without float drift (e.g. 3.75 -> 3.8).
  return Math.round(mean * 10 + 1e-9) / 10
}

export function gradeFor(score: number): Grade {
  if (score >= 4.5) return "A"
  if (score >= 3.75) return "B"
  if (score >= 3.0) return "C"
  if (score >= 2.25) return "D"
  return "F"
}

export function needsComment(r: Ratings): boolean {
  return RATING_KEYS.some((k) => r[k] <= 2)
}

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  hire: "Hire",
  no_hire: "No Hire",
  follow_up: "Follow-up Interview",
}
