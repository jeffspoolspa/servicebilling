/** Lease behaviour, against a fake RPC — the rules, not the database. */
import assert from "node:assert"
import { IonSessionLease, IonLeaseBusy, IonLeaseLost, withIonLease } from "@/lib/external/ion/session-lease"

let passed = 0
const pending: (() => Promise<void>)[] = []
const CHECK = (name: string, fn: () => Promise<void>) =>
  pending.push(async () => { await fn(); passed++; console.log(`  ok  ${name}`) })

class FakeDb {
  holder: string | null = null
  calls: string[] = []
  renewOk = true
  freeOnNextAcquire = false
  async rpc(fn: string, args: Record<string, unknown>) {
    this.calls.push(fn)
    const me = args.p_holder as string
    if (fn === "acquire_ion_session_lease") {
      if (this.holder === null || this.holder === me || this.freeOnNextAcquire) {
        this.freeOnNextAcquire = false; this.renewOk = true; this.holder = me
        return { data: [{ acquired: true, held_by: me, held_for: "t" }], error: null }
      }
      return { data: [{ acquired: false, held_by: this.holder, held_for: "other" }], error: null }
    }
    if (fn === "renew_ion_session_lease") return { data: this.renewOk && this.holder === me, error: null }
    if (fn === "release_ion_session_lease") { if (this.holder === me) this.holder = null; return { data: true, error: null } }
    return { data: null, error: null }
  }
}

CHECK("a busy session refuses rather than proceeding unprimed", async () => {
  const db = new FakeDb()
  await IonSessionLease.acquire(db, "A", "publish")
  await assert.rejects(() => IonSessionLease.acquire(db, "B", "ingest", { waitMs: 0 }), IonLeaseBusy)
})

CHECK("waiting happens on ACQUISITION — the loser touches ION not at all", async () => {
  const db = new FakeDb()
  const a = await IonSessionLease.acquire(db, "A", "publish")
  const before = db.calls.filter((c) => c === "acquire_ion_session_lease").length
  setTimeout(() => void a.release(), 40)
  const b = await IonSessionLease.acquire(db, "B", "ingest", { waitMs: 2000, pollMs: 20 })
  assert.ok(db.calls.filter((c) => c === "acquire_ion_session_lease").length > before, "it polled")
  assert.ok(db.calls.every((c) => c.includes("lease")), "and did nothing else — no priming to undo")
  await b.release()
})

CHECK("touch renews only once the TTL is part spent — chatty work is cheap", async () => {
  const db = new FakeDb()
  const l = await IonSessionLease.acquire(db, "A", "publish", { renewAfterMs: 10_000 })
  for (let i = 0; i < 50; i++) await l.touch()
  assert.equal(db.calls.filter((c) => c === "renew_ion_session_lease").length, 0, "50 calls, 0 renewals")
  await l.release()
})

CHECK("a LOST lease stops the work — never act under another holder's context", async () => {
  const db = new FakeDb()
  const l = await IonSessionLease.acquire(db, "A", "publish", { renewAfterMs: 0 })
  db.renewOk = false
  await assert.rejects(() => l.touch(), IonLeaseLost)
  await assert.rejects(() => l.touch(), IonLeaseLost, "and stays lost")
})

CHECK("a LOST lease re-runs the work under a fresh lease — never abandons it", async () => {
  const db = new FakeDb()
  let runs = 0
  const out = await withIonLease(db, "A", "publish", async (lease) => {
    runs++
    if (runs === 1) {
      // someone evicts us mid-flight
      db.holder = "someone-else"
      db.renewOk = false
      db.freeOnNextAcquire = true
      await lease.touch()          // throws IonLeaseLost
    }
    return "done"
  }, { renewAfterMs: 0, waitMs: 2000, pollMs: 5, attempts: 3 })
  assert.equal(out, "done", "the work completed")
  assert.equal(runs, 2, "it ran again rather than giving up")
})

CHECK("a business failure is NOT retried — only lease loss is", async () => {
  const db = new FakeDb()
  let runs = 0
  await assert.rejects(() => withIonLease(db, "A", "publish", async () => {
    runs++
    throw new Error("ION refused the write")
  }, { attempts: 3 }))
  assert.equal(runs, 1, "retrying a refusal would just repeat it")
})

CHECK("persistent contention surfaces instead of spinning forever", async () => {
  const db = new FakeDb()
  await assert.rejects(() => withIonLease(db, "A", "publish", async (lease) => {
    db.renewOk = false
    await lease.touch()
    return "never"
  }, { renewAfterMs: 0, attempts: 2 }), IonLeaseLost)
})

CHECK("withIonLease releases even when the body throws", async () => {
  const db = new FakeDb()
  await assert.rejects(() => withIonLease(db, "A", "publish", async () => { throw new Error("boom") }))
  assert.equal(db.holder, null, "released")
  await withIonLease(db, "B", "ingest", async () => {})
})

async function main() {
  for (const p of pending) await p()
  console.log(`\n${passed} lease checks passed`)
}
main().catch((e) => { console.error(e); process.exit(1) })
