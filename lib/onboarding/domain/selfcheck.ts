/**
 * Onboarding domain invariants as runnable assertions.
 * `npx tsx lib/onboarding/domain/selfcheck.ts`
 */
import { strict as assert } from "node:assert"
import {
  overallScore,
  gradeFor,
  needsComment,
  personFolderName,
  docFileName,
  titleCaseName,
  tenDigitPhone,
  officeForEvent,
  personalHost,
  phoneFromAnswers,
  isTestCandidate,
  statusOnBooking,
  ageOn,
  detailProblems,
  type Ratings,
  type OfficeMatcher,
} from "./index"

let checks = 0
const check = (name: string, fn: () => void) => {
  fn()
  checks++
  console.log(`  ok  ${name}`)
}
const r = (a: number, b: number, c: number, d: number, e: number, f: number): Ratings => ({
  professionalism: a, presentation: b, communication: c, interest: d, experience: e, essential_functions: f,
})

check("overall score is the mean to one decimal", () => {
  assert.equal(overallScore(r(5, 5, 5, 5, 5, 5)), 5)
  assert.equal(overallScore(r(4, 4, 4, 4, 4, 3)), 3.8) // 3.833
  assert.equal(overallScore(r(4, 4, 4, 3, 4, 3)), 3.7) // 3.667
  assert.equal(overallScore(r(3, 3, 3, 3, 3, 4)), 3.2) // 3.1667
})
check("score rejects missing or out-of-range ratings", () => {
  assert.throws(() => overallScore(r(0, 3, 3, 3, 3, 3)))
  assert.throws(() => overallScore(r(6, 3, 3, 3, 3, 3)))
  assert.throws(() => overallScore({ ...r(3, 3, 3, 3, 3, 3), interest: 2.5 }))
})
check("grade thresholds", () => {
  assert.equal(gradeFor(4.5), "A")
  assert.equal(gradeFor(4.4), "B")
  assert.equal(gradeFor(3.8), "B")
  assert.equal(gradeFor(3.7), "C")
  assert.equal(gradeFor(3.0), "C")
  assert.equal(gradeFor(2.9), "D")
  assert.equal(gradeFor(2.3), "D")
  assert.equal(gradeFor(2.2), "F")
})
check("a rating of 2 or less requires a comment", () => {
  assert.equal(needsComment(r(3, 3, 3, 3, 3, 3)), false)
  assert.equal(needsComment(r(3, 3, 2, 3, 3, 3)), true)
})
check("folder and file names follow the Drive convention", () => {
  assert.equal(personFolderName("stegall ii", "ernie"), "Stegall II, Ernie")
  assert.equal(personFolderName("RAMIREZ LOPEZ", "ezekiel"), "Ramirez Lopez, Ezekiel")
  assert.equal(personFolderName("Doyle", "Ryan", true), "_TEST Doyle, Ryan")
  assert.equal(titleCaseName("o'neil-smith"), "O'Neil-Smith")
  assert.equal(
    docFileName("Doe", "Jane", "Interview Scorecard", "2026-10-15", "pdf"),
    "Doe, Jane - Interview Scorecard - 2026-10-15.pdf",
  )
})
check("phones normalize to 10 digits", () => {
  assert.equal(tenDigitPhone("+1 (912) 555-0100"), "9125550100")
  assert.equal(tenDigitPhone("555-0100"), null)
})
const offices: OfficeMatcher[] = [
  { code: "BWK", eventTypeUris: ["https://api.calendly.com/event_types/B1"], nameKeywords: ["brunswick"] },
  { code: "RH", eventTypeUris: [], nameKeywords: ["richmond hill"] },
  { code: "SAV", eventTypeUris: [], nameKeywords: ["savannah", "garden city"] },
  { code: "CAM", eventTypeUris: [], nameKeywords: ["st marys", "st. marys"] },
]
check("office comes from the event type uri, then the name", () => {
  assert.equal(officeForEvent("https://api.calendly.com/event_types/B1", "anything", offices), "BWK")
  assert.equal(officeForEvent(null, "Interview - Brunswick (Shared)", offices), "BWK")
  assert.equal(officeForEvent(null, "Interview – Savannah", offices), "SAV")
  assert.equal(officeForEvent(null, "Interview - St Marys", offices), "CAM")
  assert.equal(officeForEvent(null, "Interview – RH", offices), "RH")
  assert.equal(officeForEvent(null, "Coffee chat", offices), null)
})
check("shared mailboxes are never the interviewer", () => {
  const shared = ["jpsbilling@jeffspoolspa.com", "jpsretail@jeffspoolspa.com"]
  assert.equal(personalHost([{ email: "JPSBilling@jeffspoolspa.com" }, { email: "mary@x.com" }], shared)?.email, "mary@x.com")
  assert.equal(personalHost([{ email: "jpsretail@jeffspoolspa.com" }], shared), null)
})
check("phone comes from the phone question", () => {
  assert.equal(phoneFromAnswers([{ question: "Phone Number", answer: " 9125550100 " }]), "9125550100")
  assert.equal(phoneFromAnswers([{ question: "Anything else?", answer: "no" }], "+19125550100"), "+19125550100")
})
check("test candidates", () => {
  assert.equal(isTestCandidate("Ryan.M.Doyle@gmail.com", "Ryan", "Doyle", ["ryan.m.doyle@gmail.com"]), true)
  assert.equal(isTestCandidate("x@y.com", "Test", "Person", []), true)
  assert.equal(isTestCandidate("x@y.com", "Tess", "Person", []), false)
})
check("a re-booking never pulls a candidate back out of the documents stage", () => {
  assert.equal(statusOnBooking(null), "scheduled")
  assert.equal(statusOnBooking("not_hired"), "scheduled")
  assert.equal(statusOnBooking("follow_up"), "scheduled")
  assert.equal(statusOnBooking("docs_submitted"), "docs_submitted")
})

check("age from date of birth", () => {
  assert.equal(ageOn("2005-10-16", "2026-10-15"), 20)
  assert.equal(ageOn("2005-10-15", "2026-10-15"), 21)
})
check("upload details: GA only, valid license, sane dates", () => {
  const ok = { legalFirst: "A", legalLast: "B", dob: "1990-01-01", dlState: "GA", dlNumber: "054123456", dlExpires: "2030-01-01", firstLicensedYear: 2008 }
  assert.deepEqual(detailProblems(ok, "2026-10-15"), [])
  assert.equal(detailProblems({ ...ok, dlState: "FL" }, "2026-10-15").length, 1)
  assert.equal(detailProblems({ ...ok, dlExpires: "2026-10-14" }, "2026-10-15").length, 1)
  assert.equal(detailProblems({ ...ok, dlNumber: "12" }, "2026-10-15").length, 1)
})

console.log(`\nonboarding domain selfcheck: ${checks} checks passed`)
