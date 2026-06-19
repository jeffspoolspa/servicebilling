"use client"

import { useEffect, useState, useActionState } from "react"
import { Pencil } from "lucide-react"
import { Dialog } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MapboxAddressAutocomplete } from "@/components/form/mapbox-address-autocomplete"
import { AddressFields } from "@/components/form/address-fields"
import { StaticMap } from "@/components/form/static-map"
import { updateCustomer, type ActionState } from "../actions"

const inputCls =
  "w-full bg-[#0E1C2A] border border-line rounded-md px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"

export interface EditableCustomer {
  account_id: number
  first_name: string
  last_name: string
  email: string
  phone: string
  street: string
  city: string
  state: string
  zip: string
}

export function EditCustomerButton({ leadId, customer }: { leadId: string; customer: EditableCustomer }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<ActionState, FormData>(updateCustomer, {})

  // Address is controlled so the Places autocomplete can fill it on pick.
  const [addr, setAddr] = useState({
    street: customer.street,
    city: customer.city,
    state: customer.state,
    zip: customer.zip,
  })

  // Close the dialog once the save succeeds (the page revalidates with new data).
  useEffect(() => {
    if (state.ok) setOpen(false)
  }, [state.ok])

  const fullAddress = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(", ")

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Edit customer"
        className="grid place-items-center w-7 h-7 rounded-md border border-line text-ink-mute hover:text-ink hover:border-cyan/40 transition-colors"
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Edit customer">
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="lead_id" value={leadId} />
          <input type="hidden" name="account_id" value={customer.account_id} />

          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" name="first_name" defaultValue={customer.first_name} />
            <Field label="Last name" name="last_name" defaultValue={customer.last_name} />
          </div>
          <Field label="Email" name="email" type="email" defaultValue={customer.email} />
          <Field label="Phone" name="phone" defaultValue={customer.phone} />

          {/* Address — set ONLY by picking from the Mapbox search, so it stays
              standardized. The fields below are read-only display + hidden submit. */}
          <div className="flex flex-col gap-2 pt-1">
            <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">Address</span>
            <MapboxAddressAutocomplete
              className={inputCls}
              placeholder="Search to change the address…"
              onPicked={(a) => setAddr({ street: a.street, city: a.city, state: a.state, zip: a.zip })}
            />
            <AddressFields street={addr.street} city={addr.city} state={addr.state} zip={addr.zip} />
            <StaticMap address={fullAddress} height={130} />
          </div>

          {state.error && <p className="text-coral text-xs">{state.error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
}: {
  label: string
  name: string
  defaultValue?: string
  type?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute">{label}</span>
      <input className={inputCls} name={name} type={type} defaultValue={defaultValue} />
    </label>
  )
}
