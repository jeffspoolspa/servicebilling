"use client"

import { useTransition } from "react"
import { Button } from "@/components/ui/button"
import { resolveDriftEntry, resolveStaleInvoiceDrift } from "./actions"

export function ResolveDriftButton({ id }: { id: string }) {
  const [pending, start] = useTransition()
  return (
    <form
      action={(fd) => {
        fd.set("id", id)
        start(async () => {
          await resolveDriftEntry(fd)
        })
      }}
    >
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Dismissing…" : "Dismiss"}
      </Button>
    </form>
  )
}

export function ClearStaleDriftButton({ disabled }: { disabled?: boolean }) {
  const [pending, start] = useTransition()
  return (
    <Button
      variant="default"
      size="sm"
      disabled={disabled || pending}
      onClick={() => start(async () => { await resolveStaleInvoiceDrift() })}
    >
      {pending ? "Clearing…" : "Clear caught-up entries"}
    </Button>
  )
}
