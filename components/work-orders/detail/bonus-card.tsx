"use client"

import { useState, useTransition } from "react"
import { Check, RotateCcw, Coins } from "lucide-react"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils/cn"

/**
 * Bonus-inclusion card on the WO detail page.
 *
 * Shows the effective inclusion state (computed from the raw override +
 * the invoice's qbo_class), lets the user toggle it, and lets them
 * reset back to the computed default.
 *
 * State model recap (see work_orders.included_in_bonus migration):
 *   - override === null → follow default (true iff qbo_class = 'Service')
 *   - override === true → explicitly included
 *   - override === false → explicitly excluded
 */
export function BonusCard({
  woNumber,
  initialOverride,
  qboClass,
}: {
  woNumber: string
  initialOverride: boolean | null
  qboClass: string | null
}) {
  const [override, setOverride] = useState<boolean | null>(initialOverride)
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const defaultIncluded = qboClass === "Service"
  const effective = override === null ? defaultIncluded : override
  const hasOverride = override !== null
  const overrideMatchesDefault =
    override !== null && override === defaultIncluded

  function post(next: boolean | null) {
    if (pending) return
    const prev = override
    setOverride(next)
    setErr(null)
    startTransition(async () => {
      try {
        const resp = await fetch(
          `/api/work-orders/${encodeURIComponent(woNumber)}/bonus`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ included: next }),
          },
        )
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          throw new Error(body?.error ?? `${resp.status}`)
        }
      } catch (e) {
        setOverride(prev)
        setErr(e instanceof Error ? e.message : "update failed")
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bonus pool</CardTitle>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] border",
            effective
              ? "border-cyan/40 bg-cyan/10 text-cyan"
              : "border-line-soft text-ink-mute",
          )}
        >
          {effective ? <Check className="w-3 h-3" strokeWidth={2.5} /> : null}
          {effective ? "Included" : "Excluded"}
        </span>
      </CardHeader>
      <CardBody className="text-[12px] space-y-3">
        <div className="flex items-start gap-2 text-ink-dim">
          <Coins
            className="w-3.5 h-3.5 mt-0.5 text-ink-mute shrink-0"
            strokeWidth={1.8}
          />
          <div className="leading-relaxed">
            Default: <span className="text-ink">{defaultIncluded ? "included" : "excluded"}</span>{" "}
            <span className="text-ink-mute">
              (invoice class {qboClass ? `= ${qboClass}` : "unknown"})
            </span>
            . Toggle below to override.
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={effective ? "primary" : "default"}
            onClick={() => post(!effective)}
            disabled={pending}
          >
            {effective ? "Remove from bonus" : "Include in bonus"}
          </Button>
          {hasOverride && !overrideMatchesDefault && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => post(null)}
              disabled={pending}
              title="Clear the user override and follow the computed default"
            >
              <RotateCcw className="w-3.5 h-3.5" strokeWidth={2} />
              Reset to default
            </Button>
          )}
          {hasOverride && (
            <span
              className="ml-auto text-[10px] uppercase tracking-[0.12em] text-sun"
              title={`Explicit override: ${override ? "included" : "excluded"}`}
            >
              · override
            </span>
          )}
        </div>

        {err && (
          <div className="text-[11px] text-coral bg-coral/[0.06] border border-coral/30 rounded px-2.5 py-1.5">
            {err}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
