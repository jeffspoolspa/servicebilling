import { readFileSync } from "node:fs"
for (const l of readFileSync(".env.local","utf8").split("\n")) { const a=l.indexOf("="); if(a>0&&!l.startsWith("#")) process.env[l.slice(0,a).trim()] ??= l.slice(a+1).trim() }
import { createClient } from "@supabase/supabase-js"
import { IonTasks } from "@/lib/external/ion/ion"
import { IonTaskAcl } from "@/lib/external/ion/acl"
import { TaskCacheRefresher } from "@/lib/maintenance/infrastructure/task-cache-refresher"
const BASE=(process.env.WINDMILL_BASE_URL??"https://app.windmill.dev/api").replace(/\/$/,"")
const WS=process.env.WINDMILL_WORKSPACE??"jps-internal"
async function main(){
  const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}})
  const {data}=await sb.schema("maintenance").from("tasks").select("id").eq("status","active").not("ion_task_id","is",null).limit(8)
  const ids=(data as {id:string}[]).map(t=>t.id)
  const ion=new IonTasks({mint:async(f)=>{const r=await fetch(`${BASE}/w/${WS}/jobs/run_wait_result/p/f/ION/api/get_session`,{method:"POST",headers:{Authorization:`Bearer ${process.env.WINDMILL_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({force_refresh:f})}); if(!r.ok) throw new Error(`mint ${r.status}`); return r.json()}})
  const t0=Date.now()
  const rep=await new TaskCacheRefresher(sb as never,ion,new IonTaskAcl()).refresh(ids,0)
  const ms=Date.now()-t0
  console.log(`refreshed ${rep.read} tasks in ${(ms/1000).toFixed(1)}s  (${(ms/Math.max(rep.read,1)/1000).toFixed(2)}s each)`)
  console.log(`slots changed ${rep.slotsChanged} · skipped ${rep.skipped.length}`)
  for (const s of rep.skipped.slice(0,3)) console.log(`   ${s.reason}`)
  const per=ms/Math.max(rep.read,1)
  console.log(`\nextrapolated for 579 active tasks: ${(per*579/60000).toFixed(0)} min`)
}
main().catch(e=>{console.error(e);process.exit(1)})
