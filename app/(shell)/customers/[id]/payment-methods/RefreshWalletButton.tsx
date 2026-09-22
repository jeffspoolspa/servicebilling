"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { refreshWalletAfterCapture } from "./actions"

// ponytail: reuses the post-capture refresh action; it is the same
// "pull this customer's wallet from QBO now" call, just on demand.
export function RefreshWalletButton({ customerId }: { customerId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  return (
    <div className="flex items-center gap-3 mb-4">
      <Button
        size="sm"
        variant="default"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await refreshWalletAfterCapture(customerId)
            setMsg(r.error ?? r.ok ?? null)
            if (r.ok) router.refresh()
          })
        }
      >
        {pending ? "Refreshing" : "Refresh from QBO"}
      </Button>
      {msg && <span className="text-ink-mute text-sm">{msg}</span>}
    </div>
  )
}
