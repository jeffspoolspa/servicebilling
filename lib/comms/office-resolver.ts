/**
 * OfficeResolver (RULED 2026-08-07): ONE class answers "which office does
 * this workflow speak as?" — different situations resolve differently, but
 * every answer is a row of public.branches (the branding source of truth:
 * brand, phone, email per branch). Callers take the branch and use its
 * phone/brand/email in their own surface; nobody hardcodes a number again.
 */

interface Db {
  schema(s: string): { from(t: string): Record<string, (...a: never[]) => unknown> }
}

export interface Branch {
  code: string
  name: string
  brand: string
  phone: string
  email: string
  city: string
}

type BranchRow = {
  id: string
  branch_code: string
  name: string
  brand: string | null
  phone: string | null
  email: string | null
  city: string
  state: string
}

const FALLBACK: Branch = {
  code: "B",
  name: "Brunswick, GA",
  brand: "Jeff's Pool & Spa Service",
  phone: "(912) 554-0636",
  email: "jpsbilling@jeffspoolspa.com",
  city: "Brunswick, GA",
}

export class OfficeResolver {
  private cache: { byId: Map<string, Branch>; byCode: Map<string, Branch> } | null = null

  constructor(private readonly sys: Db) {}

  private async branches(): Promise<{ byId: Map<string, Branch>; byCode: Map<string, Branch> }> {
    if (this.cache) return this.cache
    const { data, error } = await (this.sys.schema("public").from("branches") as never as {
      select(c: string): { eq(k: string, v: boolean): PromiseLike<{ data: unknown[] | null; error: unknown }> }
    }).select("id, branch_code, name, brand, phone, email, city, state").eq("active", true)
    if (error) throw new Error(`branches read failed: ${JSON.stringify(error).slice(0, 200)}`)
    const byId = new Map<string, Branch>()
    const byCode = new Map<string, Branch>()
    for (const r of (data ?? []) as BranchRow[]) {
      const b: Branch = {
        code: r.branch_code,
        name: r.name,
        brand: r.brand ?? FALLBACK.brand,
        phone: r.phone ?? FALLBACK.phone,
        email: r.email ?? FALLBACK.email,
        city: `${r.city}, ${r.state}`,
      }
      byId.set(r.id, b)
      byCode.set(r.branch_code, b)
    }
    this.cache = { byId, byCode }
    return this.cache
  }

  /**
   * The MONTH-LETTER situation: the office that actually serviced the pool
   * — the branch whose techs did the most visits that month (ties break to
   * the branch of the most recent visit). Falls back to geography, then
   * Brunswick.
   */
  async forServiceMonth(customerId: number, month: string, geo?: { office?: string | null; city?: string | null }): Promise<Branch> {
    const from = month.slice(0, 10)
    const to = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10)
    const { data } = await (this.sys.schema("maintenance").from("visits") as never as {
      select(c: string): {
        eq(k: string, v: number): {
          gte(k2: string, v2: string): { lt(k3: string, v3: string): { limit(n: number): PromiseLike<{ data: unknown[] | null }> } }
        }
      }
    }).select("visit_date, actual_tech_id, scheduled_tech_id").eq("customer_id", customerId).gte("visit_date", from).lt("visit_date", to).limit(200)
    const visits = ((data ?? []) as { visit_date: string; actual_tech_id: string | null; scheduled_tech_id: string | null }[])
      .map((v) => ({ date: v.visit_date, techId: v.actual_tech_id ?? v.scheduled_tech_id }))
      .filter((v): v is { date: string; techId: string } => !!v.techId)

    if (visits.length > 0) {
      const techIds = [...new Set(visits.map((v) => v.techId))]
      const { data: emps } = await (this.sys.schema("public").from("employees") as never as {
        select(c: string): { in(k: string, v: string[]): PromiseLike<{ data: unknown[] | null }> }
      }).select("id, branch_id").in("id", techIds)
      const branchOfTech = new Map(((emps ?? []) as { id: string; branch_id: string | null }[]).map((e) => [e.id, e.branch_id]))
      const { byId } = await this.branches()
      const tally = new Map<string, { count: number; latest: string }>()
      for (const v of visits) {
        const bid = branchOfTech.get(v.techId)
        if (!bid || !byId.has(bid)) continue
        const t = tally.get(bid) ?? { count: 0, latest: "" }
        t.count++
        if (v.date > t.latest) t.latest = v.date
        tally.set(bid, t)
      }
      const top = [...tally.entries()].sort((a, b) => b[1].count - a[1].count || (b[1].latest > a[1].latest ? 1 : -1))[0]
      if (top) return byId.get(top[0])!
    }
    return this.forCustomerGeo(geo?.office ?? null, geo?.city ?? null)
  }

  /** The GEOGRAPHY situation (quotes, prospect comms): office assignment,
   *  with Savannah-area cities on their own branch. */
  async forCustomerGeo(office: string | null, city: string | null): Promise<Branch> {
    const { byCode } = await this.branches()
    const cityL = (city ?? "").toLowerCase()
    const officeL = (office ?? "").toLowerCase()
    const pick =
      /savannah|garden city|pooler/.test(cityL) ? byCode.get("SAV")
      : officeL.includes("richmond") ? byCode.get("RH")
      : officeL.includes("marys") ? byCode.get("C")
      : byCode.get("B")
    return pick ?? byCode.get("B") ?? FALLBACK
  }
}
