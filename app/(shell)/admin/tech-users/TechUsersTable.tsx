"use client"

import { useActionState, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  createTechUser,
  resetTechPassword,
  deactivateTechUser,
  grantOfficeMobileAccess,
  removeOfficeMobileAccess,
  type ActionState,
} from "./actions"

interface Row {
  id: string
  display_name: string
  email?: string | null
  tech_username: string | null
  has_login: boolean
}

const empty: ActionState = {}

export function TechUsersTable({ rows, officeRows = [] }: { rows: Row[]; officeRows?: Row[] }) {
  const withLogin = rows.filter((r) => r.has_login)
  const withoutLogin = rows.filter((r) => !r.has_login)
  const officeWith = officeRows.filter((r) => r.tech_username)
  const officeWithout = officeRows.filter((r) => !r.tech_username)

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="font-display text-lg mb-3">With login ({withLogin.length})</h2>
        <div className="flex flex-col gap-2">
          {withLogin.length === 0 && (
            <div className="text-ink-mute text-sm">No maintenance techs have logins yet.</div>
          )}
          {withLogin.map((r) => (
            <ExistingRow key={r.id} row={r} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">
          Without login ({withoutLogin.length})
        </h2>
        <div className="flex flex-col gap-2">
          {withoutLogin.length === 0 && (
            <div className="text-ink-mute text-sm">All maintenance techs have logins.</div>
          )}
          {withoutLogin.map((r) => (
            <CreateRow key={r.id} row={r} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-lg mb-1">Office staff — mobile access</h2>
        <p className="text-ink-mute text-sm mb-3">
          Rides their office login: they sign in to the field app with the username below and
          their usual office password. No separate account.
        </p>
        <div className="flex flex-col gap-2">
          {officeWith.map((r) => (
            <OfficeRow key={r.id} row={r} />
          ))}
          {officeWithout.map((r) => (
            <OfficeRow key={r.id} row={r} />
          ))}
          {officeRows.length === 0 && (
            <div className="text-ink-mute text-sm">No office employees with an email on file.</div>
          )}
        </div>
      </section>
    </div>
  )
}

function OfficeRow({ row }: { row: Row }) {
  const [mode, setMode] = useState<"idle" | "grant" | "remove">("idle")
  return (
    <div className="border border-line-soft rounded-lg p-3 bg-bg-elev/40 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-ink">{row.display_name}</div>
          <div className="text-ink-mute text-xs font-mono">
            {row.tech_username ?? row.email}
          </div>
        </div>
        {mode === "idle" &&
          (row.tech_username ? (
            <Button size="sm" onClick={() => setMode("remove")}>
              Remove mobile access
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => setMode("grant")}>
              Grant mobile access
            </Button>
          ))}
      </div>
      {mode === "grant" && (
        <GrantForm employeeId={row.id} gustoEmail={row.email ?? null} onDone={() => setMode("idle")} />
      )}
      {mode === "remove" && <RemoveForm employeeId={row.id} onDone={() => setMode("idle")} />}
    </div>
  )
}

function GrantForm({
  employeeId,
  gustoEmail,
  onDone,
}: {
  employeeId: string
  gustoEmail: string | null
  onDone: () => void
}) {
  const [state, action, pending] = useActionState(grantOfficeMobileAccess, empty)
  return (
    <form action={(fd) => action(fd)} className="flex flex-col gap-2">
      <input type="hidden" name="employee_id" value={employeeId} />
      <input
        name="username"
        required
        placeholder="Username (e.g. jdoe)"
        autoCapitalize="none"
        spellCheck={false}
        className="bg-[#0E1C2A] border border-line rounded-lg px-3 py-2 text-sm text-ink focus:border-cyan focus:outline-none"
      />
      <input
        name="office_email"
        type="email"
        placeholder={`Office login email${gustoEmail ? ` (blank = ${gustoEmail})` : ""}`}
        autoCapitalize="none"
        spellCheck={false}
        className="bg-[#0E1C2A] border border-line rounded-lg px-3 py-2 text-sm text-ink focus:border-cyan focus:outline-none"
      />
      <p className="text-ink-mute text-xs">
        Gusto usually stores personal emails — enter the @jeffspoolspa.com login they use for
        this app if it differs.
      </p>
      {state.error && <p className="text-coral text-xs">{state.error}</p>}
      {state.ok && <p className="text-grass text-xs">{state.ok}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Granting…" : "Grant access"}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function RemoveForm({ employeeId, onDone }: { employeeId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(removeOfficeMobileAccess, empty)
  return (
    <form action={(fd) => action(fd)} className="flex flex-col gap-2">
      <input type="hidden" name="employee_id" value={employeeId} />
      <p className="text-ink-dim text-xs">
        Removes the field-app username. Their office login is untouched.
      </p>
      {state.error && <p className="text-coral text-xs">{state.error}</p>}
      {state.ok && <p className="text-grass text-xs">{state.ok}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Removing…" : "Confirm remove"}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function ExistingRow({ row }: { row: Row }) {
  const [mode, setMode] = useState<"idle" | "reset" | "deactivate">("idle")
  return (
    <div className="border border-line-soft rounded-lg p-3 bg-bg-elev/40 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-ink">{row.display_name}</div>
          <div className="text-ink-mute text-xs font-mono">{row.tech_username}</div>
        </div>
        {mode === "idle" && (
          <>
            <Button size="sm" onClick={() => setMode("reset")}>
              Reset password
            </Button>
            <Button size="sm" onClick={() => setMode("deactivate")}>
              Deactivate
            </Button>
          </>
        )}
      </div>
      {mode === "reset" && <ResetForm employeeId={row.id} onDone={() => setMode("idle")} />}
      {mode === "deactivate" && (
        <DeactivateForm employeeId={row.id} onDone={() => setMode("idle")} />
      )}
    </div>
  )
}

function CreateRow({ row }: { row: Row }) {
  const [mode, setMode] = useState<"idle" | "create">("idle")
  return (
    <div className="border border-line-soft rounded-lg p-3 bg-bg-elev/40 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="flex-1 text-ink">{row.display_name}</div>
        {mode === "idle" && (
          <Button size="sm" variant="primary" onClick={() => setMode("create")}>
            Add login
          </Button>
        )}
      </div>
      {mode === "create" && <CreateForm employeeId={row.id} onDone={() => setMode("idle")} />}
    </div>
  )
}

function CreateForm({ employeeId, onDone }: { employeeId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(createTechUser, empty)
  return (
    <form
      action={(fd) => {
        action(fd)
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="employee_id" value={employeeId} />
      <input
        name="username"
        required
        placeholder="Username (e.g. jane.doe)"
        autoCapitalize="none"
        spellCheck={false}
        className="bg-[#0E1C2A] border border-line rounded-lg px-3 py-2 text-sm text-ink focus:border-cyan focus:outline-none"
      />
      <input
        name="password"
        required
        type="text"
        placeholder="Initial password (min 8 chars)"
        className="bg-[#0E1C2A] border border-line rounded-lg px-3 py-2 text-sm text-ink font-mono focus:border-cyan focus:outline-none"
      />
      {state.error && <p className="text-coral text-xs">{state.error}</p>}
      {state.ok && <p className="text-grass text-xs">{state.ok}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Creating…" : "Create login"}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function ResetForm({ employeeId, onDone }: { employeeId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(resetTechPassword, empty)
  return (
    <form
      action={(fd) => {
        action(fd)
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="employee_id" value={employeeId} />
      <input
        name="password"
        required
        type="text"
        placeholder="New password (min 8 chars)"
        className="bg-[#0E1C2A] border border-line rounded-lg px-3 py-2 text-sm text-ink font-mono focus:border-cyan focus:outline-none"
      />
      {state.error && <p className="text-coral text-xs">{state.error}</p>}
      {state.ok && <p className="text-grass text-xs">{state.ok}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Resetting…" : "Reset"}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function DeactivateForm({ employeeId, onDone }: { employeeId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(deactivateTechUser, empty)
  return (
    <form
      action={(fd) => {
        action(fd)
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="employee_id" value={employeeId} />
      <p className="text-ink-dim text-xs">
        This deletes the tech&apos;s login. They won&apos;t be able to sign in until you add a new
        one.
      </p>
      {state.error && <p className="text-coral text-xs">{state.error}</p>}
      {state.ok && <p className="text-grass text-xs">{state.ok}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {pending ? "Deactivating…" : "Confirm deactivate"}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
