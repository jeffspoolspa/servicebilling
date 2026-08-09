import { createClient } from "@supabase/supabase-js"
const rt = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "routing" } })
async function main() {
  let pubId: string | null = null
  for (let i = 0; i < 240; i++) { // up to 2h
    if (!pubId) {
      const { data } = await rt.from("publications").select("id, mode, started_at, refused, finished_at")
        .eq("mode", "live").order("started_at", { ascending: false }).limit(1)
      if (data?.[0] && !data[0].finished_at) { pubId = data[0].id; console.log(`LIVE publication started: ${pubId} at ${data[0].started_at}`) }
      else if (data?.[0]?.finished_at && Date.parse(data[0].started_at) > Date.now() - 3 * 3600e3) {
        pubId = data[0].id // already finished quickly
      }
    }
    if (pubId) {
      const { data: pub } = await rt.from("publications").select("finished_at, refused, summary").eq("id", pubId).single()
      const { data: mv } = await rt.from("publication_moves").select("status").eq("publication_id", pubId)
      const counts: Record<string, number> = {}
      for (const m of mv ?? []) counts[m.status] = (counts[m.status] ?? 0) + 1
      console.log(`[${new Date().toISOString().slice(11, 19)}] moves: ${JSON.stringify(counts)}${pub?.refused ? ` REFUSED: ${pub.refused}` : ""}`)
      if (pub?.finished_at || pub?.refused) {
        console.log("FINISHED:", JSON.stringify(pub?.summary ?? {}), pub?.refused ?? "")
        // failures detail
        const { data: fails } = await rt.from("publication_moves").select("ion_task_id, error")
          .eq("publication_id", pubId).eq("status", "failed")
        for (const f of fails ?? []) console.log("  FAILED:", f.ion_task_id, String(f.error).slice(0, 200))
        return
      }
    }
    await new Promise((r) => setTimeout(r, 30000))
  }
  console.log("watcher timeout — no live publication seen")
}
main()
