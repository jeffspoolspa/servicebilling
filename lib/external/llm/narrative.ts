/**
 * The one LLM door for narrative generation. Claude when ANTHROPIC_API_KEY
 * is present (the intended provider); the existing OPENAI_API_KEY as the
 * fallback so the bridge works before the Anthropic key lands. Returns the
 * model's raw text; callers own the prompt and the parse.
 */

export async function generateText(prompt: string): Promise<string> {
  const anthropic = process.env.ANTHROPIC_API_KEY
  if (anthropic) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropic,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1600,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const j = (await r.json()) as { content: { type: string; text?: string }[] }
    return j.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
  }

  const openai = process.env.OPENAI_API_KEY
  if (openai) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openai}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1600,
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const j = (await r.json()) as { choices: { message: { content: string } }[] }
    return j.choices[0]?.message?.content ?? ""
  }

  throw new Error("no LLM key configured — set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY")
}

/** Pull a JSON object out of a model reply that may wrap it in fences. */
export function parseJsonReply<T>(raw: string): T {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`no JSON object in model reply: ${raw.slice(0, 200)}`)
  return JSON.parse(m[0]) as T
}
