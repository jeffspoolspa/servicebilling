TEAL="#0b6e6e"; BLUE="#3b6fd4"; GREY="#7a7a72"; PURPLE="#8a4fb0"; ORANGE="#d4761f"; LINE="#e4e3df"; MUT="#6b6b66"
esc=lambda s: s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
S=[]; POS={}

def box(key,x,y,w,stereo,name,color,attrs,methods=(),dashed=False,fill="#ffffff"):
    ht = 44 + 16*len(attrs) + 10 + ((6 + 16*len(methods) + 8) if methods else 0)
    sw = "1.6" if stereo=="«aggregate root»" else ("1.3" if stereo=="«entity»" else "1.2")
    da = ' stroke-dasharray="5 3"' if dashed else ""
    S.append(f'<rect x="{x}" y="{y}" width="{w}" height="{ht}" rx="8" fill="{fill}" stroke="{color}" stroke-width="{sw}"{da}/>')
    S.append(f'<text x="{x+12}" y="{y+17}" font-size="10.5" fill="{color}" letter-spacing=".04em">{esc(stereo)}</text>')
    S.append(f'<text x="{x+12}" y="{y+34}" font-size="14" font-weight="650" fill="#1c1c1a">{esc(name)}</text>')
    yy=y+44
    S.append(f'<line x1="{x}" y1="{yy-8}" x2="{x+w}" y2="{yy-8}" stroke="{LINE}"/>')
    rows={}
    for i,a in enumerate(attrs):
        t=a; col="#3a3a36"
        if t.startswith("~"): t=t[1:]; col=MUT
        S.append(f'<text x="{x+12}" y="{yy+8}" font-size="12" fill="{col}" font-family="SF Mono,ui-monospace,Menlo,monospace">{esc(t)}</text>')
        rows[i]=yy+4; yy+=16
    if methods:
        yy+=6
        S.append(f'<line x1="{x}" y1="{yy-8}" x2="{x+w}" y2="{yy-8}" stroke="{LINE}"/>')
        for m in methods:
            S.append(f'<text x="{x+12}" y="{yy+8}" font-size="12" fill="{PURPLE}" font-family="SF Mono,ui-monospace,Menlo,monospace">{esc(m)}</text>')
            yy+=16
    POS[key]=dict(x=x,y=y,w=w,h=ht,x2=x+w,y2=y+ht,cx=x+w/2,cy=y+ht/2,rows=rows)
    return POS[key]

def label(mx,my,text,color=MUT):
    w=len(text)*5.7+10
    S.append(f'<rect x="{mx-w/2}" y="{my-10}" width="{w}" height="14" rx="3" fill="#ffffff" opacity=".96"/>')
    S.append(f'<text x="{mx}" y="{my}" font-size="10.5" fill="{color}" text-anchor="middle">{esc(text)}</text>')

def ref(x1,y1,x2,y2,text,mid=None,curve=None):
    d=f'M{x1},{y1} L{x2},{y2}' if not curve else f'M{x1},{y1} C{curve[0]},{curve[1]} {curve[2]},{curve[3]} {x2},{y2}'
    S.append(f'<path d="{d}" fill="none" stroke="{MUT}" stroke-width="1.2" stroke-dasharray="5 4" marker-end="url(#op)"/>')
    label(*(mid or ((x1+x2)/2,(y1+y2)/2-5)), text)

def comp(x1,y1,x2,y2,color=TEAL):   # filled diamond at the OWNER end (x1,y1)
    S.append(f'<path d="M{x1},{y1} L{x2},{y2}" fill="none" stroke="{color}" stroke-width="1.3" marker-start="url(#dia)"/>')

# ---- domain: customers lane
c   = box("cust",28,52,392,"«aggregate root»","Customer",TEAL,
      ["id: uuid              (Customers.id)","displayName: text","shape: CustomerShape","qbo: ExternalRef","ion: ExternalRef","~onboarding: derived from the two refs"],
      ["blocks('create_task'): string | null   [I-C3]","onboarding: drafted|awaiting_ion|linked"])
er  = box("eref",28,c["y2"]+20,190,"«value object»","ExternalRef",GREY,
      ["unlinked","awaiting(since, attempts)","linked(id, method,","   confidence, at)","ambiguous(candidates[])"],dashed=True)
cs  = box("shape",230,c["y2"]+20,190,"«value object»","CustomerShape",GREY,
      ["firstName / lastName","street / city / state / zip","phone / email"],dashed=True)
sp  = box("prof",28,er["y2"]+20,190,"«value object»","ServiceProfile",GREY,
      ["cadence: resolved | ambiguous","ratePerVisit / monthly","poolType","notes[]"],dashed=True)
cd  = box("draft",230,er["y2"]+20,190,"«entity»","CustomerDraft",BLUE,
      ["shape: CustomerShape","profile: ServiceProfile","violations: Violation[]"])
ds  = box("rules",28,max(sp["y2"],cd["y2"])+20,392,"«domain service»","customer.ts — pure rules",PURPLE,
      ["no I/O · selfchecked"],
      ["customerFit(shape) -> Violation[]  both doors","draftCustomer(row) -> CustomerDraft","resolveCadence(row) -> resolved|ambiguous","parseServiceDays(text) -> weekday[]"],fill="#f7f2fa")

# ---- domain: maintenance lane
tk  = box("task",468,52,384,"«aggregate root»","Task   (maintenance)",TEAL,
      ["id: uuid          (maintenance.tasks.id)","customer_id -> Customers.id","ion_task_id: text","frequency / days_per_week","price_per_visit_cents","ion_invoice_type","~schedules: TaskSchedule[*]"])
tsc = box("slot",468,tk["y2"]+20,384,"«entity»","TaskSchedule   (the slot)",BLUE,
      ["task_id -> tasks.id","day_of_week: 0..6","tech_employee_id -> employees.id","frequency: weekly|biweekly_a|_b|monthly","starts_on / active"])
sl  = box("loc",468,tsc["y2"]+20,384,"«entity»","ServiceLocation",BLUE,
      ["id                (service_locations.id)","account_id -> Customers.id","place_id: text     <- THE IDENTITY","latitude / longitude","geocode_status / place_provider","is_primary / is_active"])

LANE_B = max(ds["y2"], sl["y2"]) + 18
INF_T  = LANE_B + 22
qbo = box("qbo",28,INF_T+40,264,"«infra · gateway»","Qbo / QboCustomers",ORANGE,
      ["minter -> f/qbo/api/get_access_token","(the one rotating-token refresher)"],
      ["createCustomer() -> {qboId}  echo","findByDisplayName()"],fill="#fffdf9")
ion = box("ion",308,INF_T+40,270,"«infra · gateway»","Ion / IonTasks / IonCustomers",ORANGE,
      ["minter -> f/ION/api/get_session","(chromium login, the only one)"],
      ["readTask() / applyWeeks()  read-back","createTask()  task-list diff proof","setStartDate()    search()"],fill="#fffdf9")
acl = box("acl",594,INF_T+40,258,"«infra · ACL»","IonTaskAcl",ORANGE,
      ["translation only · no HTTP · no rules"],
      ["toIonWrite() / toIonCreate()","fromIonForm() / fromIonResults()","maintenanceDefaults()","matchIonCustomer()","anchorOf() / startsOnFor()"],fill="#fffdf9")
rp  = box("repo",28,max(qbo["y2"],ion["y2"],acl["y2"])+26,404,"«infra · repository»","SupabaseCustomerRepository",ORANGE,
      ["public.Customers + service_locations"],
      ["findByPlaceId()   identity dedup","findByStreet()    fallback dedup","create()          canonical RPC door","stampQboId()      row-count asserted","awaitingIon() / linkIon() / linkedOf()"],fill="#fffdf9")
sv  = box("svc",448,rp["y"],404,"«application»","services — one sentence each",PURPLE,
      ["callable by any UI, script, or agent"],
      ["OnboardingService.onboard(draft)","LinkIonService.link(accountIds)","TaskOpeningService.open(tasks)","PublishService.publish(scenarioId)"],fill="#f7f2fa")
INF_B = max(rp["y2"], sv["y2"]) + 18
H = INF_B + 14

# ---- arrows
comp(c["cx"]-104, c["y2"], c["cx"]-104, er["y"])                 # Customer <>- ExternalRef
comp(cs["cx"],    c["y2"], cs["cx"],    cs["y"])                 # Customer <>- CustomerShape
comp(cd["cx"],    cd["y"], cd["cx"],    cs["y2"], BLUE)          # Draft <>- CustomerShape
comp(cd["x"],     cd["y"]+40, sp["x2"], cd["y"]+40, BLUE)        # Draft <>- ServiceProfile
comp(tsc["cx"],   tk["y2"], tsc["cx"],  tsc["y"])                # Task <>- TaskSchedule
ref(tk["x"], tk["rows"][1], c["x2"]+2, tk["rows"][1], "customer_id", mid=(444, tk["rows"][1]-9))
ref(sl["x"], sl["rows"][1], c["x2"]+2, c["y"]+120, "account_id",
    mid=(444, (sl["rows"][1]+c["y"]+120)/2), curve=(438, sl["rows"][1], 438, c["y"]+120))
ref(sv["x"], sv["y"]+46, rp["x2"]+2, sv["y"]+46, "uses", mid=(440, sv["y"]-6))
ref(sv["x"]+120, sv["y"], ion["cx"], ion["y2"]+2, "calls", mid=(505, sv["y"]-14))
ref(sv["x"]+40, sv["y"], qbo["cx"]+70, qbo["y2"]+2, "calls", mid=(330, sv["y"]-14))
ref(acl["cx"], acl["y2"], sv["x"]+300, sv["y"]-2, "translates for", mid=(730, sv["y"]-14))

OUT=[f'<svg viewBox="0 0 880 {H}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif">',
'''<defs>
<marker id="op" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
<path d="M0,1 L9,5 L0,9" fill="none" stroke="#6b6b66" stroke-width="1.2"/></marker>
<marker id="dia" viewBox="0 0 12 12" refX="1" refY="6" markerWidth="11" markerHeight="11" orient="auto">
<path d="M1,6 L6,3 L11,6 L6,9 Z" fill="#0b6e6e" stroke="#0b6e6e"/></marker>
</defs>''',
f'<rect x="8" y="8" width="424" height="{LANE_B-8}" rx="12" fill="#f2f8f8" stroke="{LINE}"/>',
f'<text x="24" y="32" font-size="11" font-weight="700" fill="{TEAL}" letter-spacing=".1em">DOMAIN · CUSTOMERS</text>',
f'<rect x="448" y="8" width="424" height="{LANE_B-8}" rx="12" fill="#faf6fd" stroke="{LINE}"/>',
f'<text x="464" y="32" font-size="11" font-weight="700" fill="{PURPLE}" letter-spacing=".1em">DOMAIN · MAINTENANCE (existing)</text>',
f'<rect x="8" y="{INF_T}" width="864" height="{INF_B-INF_T}" rx="12" fill="#fdfaf6" stroke="{LINE}"/>',
f'<text x="24" y="{INF_T+24}" font-size="11" font-weight="700" fill="{ORANGE}" letter-spacing=".1em">INFRASTRUCTURE · EXTERNAL SYSTEM OBJECTS (ADR 012) + APPLICATION</text>'] + S + ['</svg>']
open("docs/model/_uml.svg","w").write("\n".join(OUT))
print("height", H)
