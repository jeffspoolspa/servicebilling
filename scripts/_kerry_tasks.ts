import { readFileSync } from "node:fs"
for (const l of readFileSync(".env.local","utf8").split("\n")) { const a=l.indexOf("="); if(a>0&&!l.startsWith("#")) process.env[l.slice(0,a).trim()] ??= l.slice(a+1).trim() }
import { IonTasks } from "@/lib/external/ion/ion"
const BASE=(process.env.WINDMILL_BASE_URL??"https://app.windmill.dev/api").replace(/\/$/,"")
const WS=process.env.WINDMILL_WORKSPACE??"jps-internal"
async function main(){
  const ion=new IonTasks({mint:async(f)=>{const r=await fetch(`${BASE}/w/${WS}/jobs/run_wait_result/p/f/ION/api/get_session`,{method:"POST",headers:{Authorization:`Bearer ${process.env.WINDMILL_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({force_refresh:f})}); if(!r.ok) throw new Error(`mint ${r.status}`); return r.json()}})
  const ids=await ion.listTaskIds("2439378")
  console.log(`Kerry has ${ids.size} task(s) in ION: ${[...ids].join(", ")}\n`)
  for (const id of ids) {
    const f = await ion.readTask(id, "2439378")
    console.log(`  ${id}: starts ${f.startsOn || "—"}  ends ${f.fields["EndsOn"] || "—"}  ${f.serviceRepeatText}`)
  }
}
main().catch(e=>{console.error(e);process.exit(1)})
