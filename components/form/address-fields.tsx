import { cn } from "@/lib/utils/cn"

/**
 * Read-only display of a standardized address as separate fields (Street / City /
 * State / ZIP) — looks like fields but is NOT hand-editable. The address is set
 * only via the Mapbox picker; hidden inputs carry the values so a form still
 * submits street/city/state/zip. Shared by the new-lead form + edit-customer dialog.
 */
export function AddressFields({
  street,
  city,
  state,
  zip,
  className,
}: {
  street: string
  city: string
  state: string
  zip: string
  className?: string
}) {
  return (
    <div className={cn("grid grid-cols-6 gap-3", className)}>
      <input type="hidden" name="street" value={street} />
      <input type="hidden" name="city" value={city} />
      <input type="hidden" name="state" value={state} />
      <input type="hidden" name="zip" value={zip} />
      <ReadField cls="col-span-6" label="Street" value={street} />
      <ReadField cls="col-span-3" label="City" value={city} />
      <ReadField cls="col-span-1" label="State" value={state} />
      <ReadField cls="col-span-2" label="ZIP" value={zip} />
    </div>
  )
}

function ReadField({ cls, label, value }: { cls?: string; label: string; value: string }) {
  return (
    <div className={cls}>
      <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute mb-1">{label}</div>
      <div className="flex min-h-[34px] items-center truncate rounded-md border border-line bg-[#0E1C2A] px-2.5 py-1.5 text-[13px] text-ink-dim">
        {value || <span className="text-ink-mute">—</span>}
      </div>
    </div>
  )
}
