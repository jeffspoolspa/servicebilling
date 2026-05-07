"use client"

import { useActionState, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardBody } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { Plus, KeyRound, Trash2, Save, X } from "lucide-react"
import { MODULES, type ModuleKey, type RoleKey } from "@/lib/auth/modules"
import {
  createAppUser,
  updateUserAccess,
  resetAppUserPassword,
  deactivateAppUser,
  type ActionState,
} from "./actions"

export interface AppUserRow {
  auth_user_id: string
  email: string
  created_at: string
  last_sign_in_at: string | null
  access: Array<{ app: string; role: string }>
}

const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[]
const empty: ActionState = {}

/**
 * Encode the access matrix to/from the comma-separated wire format used by
 * the server actions: "service:viewer,maintenance:admin"
 */
function encodeAccess(picks: Partial<Record<ModuleKey, RoleKey>>): string {
  return Object.entries(picks)
    .filter(([, r]) => r !== undefined)
    .map(([m, r]) => `${m}:${r}`)
    .join(",")
}

function rowToPicks(row: AppUserRow): Partial<Record<ModuleKey, RoleKey>> {
  const picks: Partial<Record<ModuleKey, RoleKey>> = {}
  for (const r of row.access) {
    if ((MODULE_KEYS as string[]).includes(r.app)) {
      picks[r.app as ModuleKey] = r.role as RoleKey
    }
  }
  return picks
}

export function UsersTable({ rows }: { rows: AppUserRow[] }) {
  const [adding, setAdding] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-ink-dim text-[12px]">{rows.length} user{rows.length === 1 ? "" : "s"}</div>
        {!adding && (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <Plus className="w-3.5 h-3.5" strokeWidth={2} />
            Add user
          </Button>
        )}
      </div>

      {adding && <AddUserForm onCancel={() => setAdding(false)} />}

      <div className="flex flex-col gap-2">
        {rows.length === 0 && (
          <Card>
            <CardBody>
              <div className="text-ink-mute text-sm">No app users yet.</div>
            </CardBody>
          </Card>
        )}
        {rows.map((row) => (
          <UserRow key={row.auth_user_id} row={row} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add user form
// ---------------------------------------------------------------------------

function AddUserForm({ onCancel }: { onCancel: () => void }) {
  const [state, formAction, pending] = useActionState(createAppUser, empty)
  const [picks, setPicks] = useState<Partial<Record<ModuleKey, RoleKey>>>({})

  return (
    <Card>
      <CardBody>
        <form action={formAction} className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-[15px]">Add user</h3>
            <button type="button" onClick={onCancel} className="text-ink-mute hover:text-ink">
              <X className="w-4 h-4" strokeWidth={2} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input
              name="email"
              type="email"
              required
              placeholder="email@jeffspoolspa.com"
              className="bg-[#0E1C2A] border border-line rounded-md px-3 py-2 text-sm text-ink"
            />
            <input
              name="password"
              type="text"
              required
              minLength={8}
              placeholder="Initial password (min 8 chars)"
              className="bg-[#0E1C2A] border border-line rounded-md px-3 py-2 text-sm text-ink"
            />
          </div>

          <AccessMatrix picks={picks} onChange={setPicks} />
          <input type="hidden" name="access" value={encodeAccess(picks)} />

          {state.error && <ErrorMsg msg={state.error} />}
          {state.ok && <div className="text-grass text-[12px]">{state.ok}</div>}

          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={pending}>
              {pending ? "Creating…" : "Create user"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Existing user row
// ---------------------------------------------------------------------------

function UserRow({ row }: { row: AppUserRow }) {
  const [editing, setEditing] = useState(false)
  const [resetting, setResetting] = useState(false)

  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-ink text-[14px] truncate">{row.email}</div>
            <div className="text-ink-mute text-[11px] mt-0.5">
              {row.last_sign_in_at
                ? `last in ${new Date(row.last_sign_in_at).toLocaleDateString()}`
                : "never signed in"}
            </div>
          </div>
          <AccessSummaryPills row={row} />
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close" : "Edit access"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setResetting((v) => !v)}>
            <KeyRound className="w-3.5 h-3.5" strokeWidth={1.8} />
            {resetting ? "Cancel" : "Reset pw"}
          </Button>
        </div>

        {editing && <EditAccessForm row={row} onDone={() => setEditing(false)} />}
        {resetting && <ResetPasswordForm row={row} onDone={() => setResetting(false)} />}
      </CardBody>
    </Card>
  )
}

function AccessSummaryPills({ row }: { row: AppUserRow }) {
  if (row.access.length === 0) {
    return <Pill tone="neutral">no access</Pill>
  }
  return (
    <div className="flex gap-1 flex-wrap">
      {row.access.map((a) => (
        <Pill key={`${a.app}-${a.role}`} tone={a.role === "admin" ? "coral" : "cyan"}>
          {MODULES[a.app as ModuleKey]?.label ?? a.app}: {a.role}
        </Pill>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit access form
// ---------------------------------------------------------------------------

function EditAccessForm({ row, onDone }: { row: AppUserRow; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(updateUserAccess, empty)
  const [picks, setPicks] = useState<Partial<Record<ModuleKey, RoleKey>>>(rowToPicks(row))
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false)
  const [deactivateState, deactivateAction, deactivating] = useActionState(deactivateAppUser, empty)

  return (
    <div className="mt-3 pt-3 border-t border-line-soft flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="auth_user_id" value={row.auth_user_id} />
        <input type="hidden" name="access" value={encodeAccess(picks)} />

        <AccessMatrix picks={picks} onChange={setPicks} />

        {state.error && <ErrorMsg msg={state.error} />}
        {state.ok && <div className="text-grass text-[12px]">{state.ok}</div>}

        <div className="flex justify-between items-center">
          <button
            type="button"
            onClick={() => setConfirmingDeactivate((v) => !v)}
            className="text-coral text-[11px] hover:underline inline-flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" strokeWidth={2} />
            Deactivate user
          </button>

          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              Close
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={pending}>
              <Save className="w-3.5 h-3.5" strokeWidth={2} />
              {pending ? "Saving…" : "Save access"}
            </Button>
          </div>
        </div>
      </form>

      {confirmingDeactivate && (
        <form action={deactivateAction} className="flex items-center gap-2 bg-coral/10 border border-coral/30 rounded-md px-3 py-2">
          <input type="hidden" name="auth_user_id" value={row.auth_user_id} />
          <span className="text-[11px] text-coral flex-1">
            Deactivate {row.email}? Deletes their auth account + all access. Reversible only by recreating.
          </span>
          {deactivateState.error && <ErrorMsg msg={deactivateState.error} />}
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDeactivate(false)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={deactivating}>
            {deactivating ? "Deactivating…" : "Confirm deactivate"}
          </Button>
        </form>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reset password form
// ---------------------------------------------------------------------------

function ResetPasswordForm({ row, onDone }: { row: AppUserRow; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(resetAppUserPassword, empty)

  return (
    <form action={formAction} className="mt-3 pt-3 border-t border-line-soft flex items-center gap-2">
      <input type="hidden" name="auth_user_id" value={row.auth_user_id} />
      <input
        name="password"
        type="text"
        required
        minLength={8}
        placeholder="New password (min 8 chars)"
        className="flex-1 bg-[#0E1C2A] border border-line rounded-md px-3 py-2 text-sm text-ink"
      />
      {state.error && <ErrorMsg msg={state.error} />}
      {state.ok && <div className="text-grass text-[12px]">{state.ok}</div>}
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      <Button type="submit" size="sm" variant="primary" disabled={pending}>
        {pending ? "Resetting…" : "Reset"}
      </Button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Access matrix — checkbox + role dropdown per module
// ---------------------------------------------------------------------------

function AccessMatrix({
  picks,
  onChange,
}: {
  picks: Partial<Record<ModuleKey, RoleKey>>
  onChange: (next: Partial<Record<ModuleKey, RoleKey>>) => void
}) {
  function toggle(module: ModuleKey, on: boolean) {
    const next = { ...picks }
    if (on) {
      // Default to viewer when available, otherwise the only role (admin).
      const moduleSpec = MODULES[module]
      if (moduleSpec.roles.viewer) next[module] = "viewer"
      else next[module] = Object.keys(moduleSpec.roles)[0] as RoleKey
    } else {
      delete next[module]
    }
    onChange(next)
  }

  function setRole(module: ModuleKey, role: RoleKey) {
    onChange({ ...picks, [module]: role })
  }

  return (
    <div className="flex flex-col gap-1.5 bg-white/[0.02] border border-line-soft rounded-md p-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-mute mb-1">
        Module access
      </div>
      {MODULE_KEYS.map((mod) => {
        const moduleSpec = MODULES[mod]
        const current = picks[mod]
        const enabled = current !== undefined
        const roleOptions = Object.entries(moduleSpec.roles) as Array<[RoleKey, { label: string }]>
        return (
          <label
            key={mod}
            className="flex items-center gap-2 text-[12px] py-1.5 cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => toggle(mod, e.target.checked)}
            />
            <span className="text-ink min-w-[100px]">{moduleSpec.label}</span>
            <span className="text-ink-mute text-[11px] flex-1 truncate">
              {moduleSpec.description}
            </span>
            <select
              value={current ?? ""}
              disabled={!enabled}
              onChange={(e) => setRole(mod, e.target.value as RoleKey)}
              className="bg-[#0E1C2A] border border-line rounded px-2 py-1 text-[12px] text-ink disabled:opacity-40"
            >
              {!enabled && <option value="">—</option>}
              {roleOptions.map(([r, spec]) => (
                <option key={r} value={r}>
                  {spec.label}
                </option>
              ))}
            </select>
          </label>
        )
      })}
    </div>
  )
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <div className="text-coral text-[11px] border border-coral/20 bg-coral/5 rounded px-2 py-1.5">
      {msg}
    </div>
  )
}
