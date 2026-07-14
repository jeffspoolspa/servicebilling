import { NextResponse, type NextRequest } from "next/server"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"

// Voice-to-text for the field Follow-Up description. The tech records raw audio
// (browser MediaRecorder); we transcribe it here with a domain prompt and then
// tidy it into readable notes. We deliberately do NOT rely on the device's
// dictation — the audio→text step is the weak link, so we redo it with a strong
// model + pool-service vocabulary, then polish the (already-correct) text.
export const runtime = "nodejs"
export const maxDuration = 60

const OPENAI = "https://api.openai.com/v1"
const VOCAB =
  "cyanuric acid, free chlorine, muriatic acid, calcium hardness, total alkalinity, " +
  "salt cell, salt system, DE filter, cartridge filter, sand filter, skimmer, " +
  "Stenner pump, chlorinator, actuator, impeller, o-ring, gasket, pump motor, " +
  "variable speed pump, heater, heat pump, main drain, return jet, backwash, " +
  "phosphates, algae, green pool, chlorine tabs, shock, DPD, pool, spa"

export async function POST(req: NextRequest) {
  const employee = await getCurrentEmployee()
  if (!employee || employee.department_id !== MAINTENANCE_DEPARTMENT_ID) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 })
  }

  const key = process.env.OPENAI_API_KEY
  if (!key) return NextResponse.json({ error: "Transcription is not configured." }, { status: 503 })

  const form = await req.formData()
  const audio = form.get("audio")
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "No audio received." }, { status: 400 })
  }
  const customer = (form.get("customer") as string | null) || ""
  const issue = (form.get("issue") as string | null) || ""

  // 1) Transcribe with context.
  const prompt =
    "Field voice note from a Jeff's Pool & Spa Service technician in coastal Georgia" +
    (customer ? ` about customer ${customer}` : "") +
    (issue ? `, issue type: ${issue}` : "") +
    `. Expect pool-service vocabulary: ${VOCAB}.`

  const ext = (audio.type.split("/")[1] || "webm").split(";")[0]
  const at = new FormData()
  at.append("file", audio, `note.${ext}`)
  at.append("model", "gpt-4o-transcribe")
  at.append("prompt", prompt)
  at.append("response_format", "json")

  const tr = await fetch(`${OPENAI}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: at,
  })
  if (!tr.ok) {
    return NextResponse.json(
      { error: `Transcription failed (${tr.status}).` },
      { status: 502 },
    )
  }
  const raw = (((await tr.json()) as { text?: string }).text || "").trim()
  if (!raw) return NextResponse.json({ text: "" })

  // 2) Light cleanup into readable notes (polish correct text; never invent).
  try {
    const cl = await fetch(`${OPENAI}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You clean up a pool-service technician's raw voice note into concise, " +
              "readable field notes. Fix grammar, punctuation, and obviously mis-heard " +
              "pool-industry terms. Keep it factual and in the tech's own voice. Do NOT " +
              "add information that isn't in the note. Return only the cleaned note text.",
          },
          { role: "user", content: raw },
        ],
      }),
    })
    if (cl.ok) {
      const cleaned = ((await cl.json()) as { choices?: { message?: { content?: string } }[] })
        .choices?.[0]?.message?.content?.trim()
      if (cleaned) return NextResponse.json({ text: cleaned, raw })
    }
  } catch {
    // fall through to the raw transcript
  }
  return NextResponse.json({ text: raw, raw })
}
