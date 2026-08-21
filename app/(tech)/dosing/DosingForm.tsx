"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { ActiveCustomer } from "@/lib/entities/follow-up/shared"
import { CustomerSelectSheet } from "../follow-up/CustomerPicker"
import { useBottomBar } from "../bottom-bar"
import { getPoolConfig, getRecommendation, savePoolConfig } from "./actions"
// EXPERIMENT branch: the Apple-Weather-card pour sheet stands in for the
// production sheet. Do not merge — swap back to ./PourSheet to compare.
import { WeatherPourSheet as PourSheet } from "./WeatherSheet"
import { ReadingWheelSheet } from "./ReadingWheel"
import {
  READING_FIELDS,
  type DosingResponse,
  type PoolConfig,
  type ReadingKey,
  type Sanitiser,
} from "./shared"

// The form offers only the two chlorination types the branches actually run
// (ruled 2026-08-21); the API's "liquid" stays reachable via the contract.
const SANITISER_OPTIONS = [
  { value: "tab", label: "Tablet" },
  { value: "salt", label: "Salt" },
] as const

const VOLUME_WHEEL = {
  label: "Pool volume",
  unit: "gal",
  min: 5000,
  max: 40000,
  step: 2500,
  start: 12500,
}

// Quick-pick pills on the volume wheel — common sizes on the 2,500 grid.
const VOLUME_PRESETS = [
  { label: "Small", value: 7500 },
  { label: "Mid", value: 12500 },
  { label: "Average", value: 15000 },
  { label: "Large", value: 25000 },
]

export function DosingForm({ customers }: { customers: ActiveCustomer[] }) {
  const [customerId, setCustomerId] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [volume, setVolume] = useState<number | null>(null)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [sanitiser, setSanitiser] = useState<Sanitiser>("tab")
  const [readings, setReadings] = useState<Partial<Record<ReadingKey, number>>>({})
  const [wheelFor, setWheelFor] = useState<ReadingKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DosingResponse | null>(null)
  const [algae, setAlgae] = useState(false)
  const [recalcError, setRecalcError] = useState<string | null>(null)
  // Saved per-customer dosing defaults (maintenance.pool_configs): loaded on
  // customer pick; when present and untouched, the volume+chlorination rows
  // collapse to a summary with an Edit button.
  const [savedConfig, setSavedConfig] = useState<PoolConfig | null>(null)
  const [configEditing, setConfigEditing] = useState(false)
  const [savePending, setSavePending] = useState(false)
  const [pending, startTransition] = useTransition()
  const { setAction } = useBottomBar()

  const customer = customers.find((c) => String(c.customer_id) === customerId)
  const volumeNum = volume ?? 0
  // Salt readings only apply to salt pools — the tile hides otherwise, and a
  // value picked before switching away is dropped from the payload too.
  const visibleFields = READING_FIELDS.filter(
    (f) => !("hidden" in f && f.hidden) && (f.key !== "salt" || sanitiser === "salt"),
  )
  const measured = Object.fromEntries(
    visibleFields.filter((f) => readings[f.key] != null).map((f) => [f.key, readings[f.key]]),
  )
  // FC, pH, CYA and Alk are required by the API.
  const requiredMet = READING_FIELDS.filter((f) => "required" in f && f.required).every(
    (f) => readings[f.key] != null,
  )
  const canSubmit = volumeNum >= 1500 && requiredMet && !pending

  const submit = () => {
    setError(null)
    setRecalcError(null)
    startTransition(async () => {
      const res = await getRecommendation({
        ...(customerId ? { customerId } : {}),
        pool: { volumeGallons: volumeNum, sanitiser },
        readings: measured,
      })
      if (res.ok) {
        setAlgae(false)
        setResult(res.data)
        window.scrollTo({ top: 0 })
      } else {
        setError(res.error)
      }
    })
  }

  // The chlorine card's "Algae present" toggle: same sample, re-called with
  // the flag — the new response re-anchors doses and warnings. On failure
  // the sheet stays and the toggle reverts.
  const toggleAlgae = (next: boolean) => {
    setAlgae(next)
    setRecalcError(null)
    startTransition(async () => {
      const res = await getRecommendation({
        ...(customerId ? { customerId } : {}),
        pool: { volumeGallons: volumeNum, sanitiser },
        readings: measured,
        ...(next ? { algaeOrCloudy: true } : {}),
      })
      if (res.ok) {
        setResult(res.data)
      } else {
        setAlgae(!next)
        setRecalcError(res.error)
      }
    })
  }

  const SANI_LABEL: Record<string, string> = { tab: "Tablet", liquid: "Liquid", salt: "Salt" }
  const configDirty =
    !savedConfig || savedConfig.volumeGallons !== volume || savedConfig.sanitiser !== sanitiser
  const saveConfig = async () => {
    if (volume == null || !customerId || savePending) return
    setSavePending(true)
    const res = await savePoolConfig({ customerId, volumeGallons: volume, sanitiser })
    setSavePending(false)
    if (res.ok) {
      setSavedConfig({ volumeGallons: volume, sanitiser })
      setConfigEditing(false)
    } else {
      setError(res.error ?? "Could not save.")
    }
  }

  // New = a different sample: wipe everything, back to a blank form.
  const newSample = () => {
    setResult(null)
    setReadings({})
    setVolume(null)
    setSanitiser("tab")
    setCustomerId("")
    setError(null)
    setAlgae(false)
    setRecalcError(null)
    setSavedConfig(null)
    setConfigEditing(false)
  }

  // The bottom bar is the page's primary action: submit while filling the
  // form, New sample while the pour sheet is up.
  useEffect(() => {
    if (result) {
      setAction({ label: "New sample", onClick: newSample })
    } else if (canSubmit || pending) {
      setAction({
        label: pending ? "Calculating…" : "Get pour sheet",
        onClick: submit,
        disabled: pending,
      })
    } else {
      setAction(null)
    }
    return () => setAction(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, pending, canSubmit, volume, sanitiser, readings, customerId])

  if (result)
    return (
      <PourSheet
        result={result}
        customerName={customer?.customer_name}
        onNewSample={newSample}
        onEditSample={() => setResult(null)}
        algae={algae}
        onAlgaeChange={toggleAlgae}
        recalcPending={pending}
        recalcError={recalcError}
      />
    )

  return (
    <div className="space-y-6">
      {/* ── Form header ── */}
      <h1 className="font-display text-xl text-ink">New sample</h1>

      {/* Customer (optional) — compact inline picker trigger */}
      <section className="flex items-center justify-between gap-3">
        <label className="text-base font-medium text-ink-dim shrink-0">
          Customer <span className="text-ink-mute font-normal">(optional)</span>
        </label>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          aria-haspopup="dialog"
          className={cn(
            "flex items-center gap-1.5 h-10 px-4 rounded-full text-base max-w-[55%]",
            "border transition-colors duration-150 active:scale-[0.98]",
            customer
              ? "bg-cyan/10 border-cyan/40 text-ink"
              : "bg-black/25 border-line-soft text-ink-dim",
          )}
        >
          <span className="truncate">{customer ? customer.customer_name : "Select"}</span>
          <ChevronDown className="w-3.5 h-3.5 text-cyan shrink-0" strokeWidth={2.2} />
        </button>
        {pickerOpen && (
          <CustomerSelectSheet
            customers={customers}
            value={customerId}
            onPick={(id) => {
              setCustomerId(String(id))
              setPickerOpen(false)
              setSavedConfig(null)
              setConfigEditing(false)
              void getPoolConfig(String(id)).then((cfg) => {
                if (!cfg) return
                setSavedConfig(cfg)
                setVolume(cfg.volumeGallons)
                setSanitiser(cfg.sanitiser)
              })
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </section>

      {customer && savedConfig && !configEditing ? (
        /* Saved pool config — one summary row; Edit expands the controls */
        <section className="flex items-center justify-between gap-3">
          <label className="text-base font-medium text-ink-dim shrink-0">Pool</label>
          <div className="flex items-center gap-2">
            <span className="text-base tabular-nums text-ink">
              {savedConfig.volumeGallons.toLocaleString()} gal · {SANI_LABEL[savedConfig.sanitiser]}
            </span>
            <button
              type="button"
              onClick={() => setConfigEditing(true)}
              className="h-8 px-3 rounded-full text-sm border border-line-soft text-ink-dim active:scale-[0.97] transition-transform"
            >
              Edit
            </button>
          </div>
        </section>
      ) : (
        <>
      {/* Pool volume + chlorination side by side — headers in line, the
          selectors below them, each in its own card (same label idiom as
          the pour sheet's customer card). */}
      <div className="grid grid-cols-2 gap-3 items-stretch">
        <section className="rounded-xl border border-line-soft bg-bg-elev px-3.5 py-3">
          <div className="text-[10px] uppercase tracking-wide text-ink-mute">Volume (gal)</div>
          <button
            type="button"
            onClick={() => setVolumeOpen(true)}
            aria-haspopup="dialog"
            className={cn(
              "mt-2 w-full h-11 px-4 flex items-center justify-between rounded-full text-lg tabular-nums",
              "border transition-colors duration-150 active:scale-[0.98]",
              volume != null
                ? "bg-cyan/10 border-cyan/40 text-ink"
                : "bg-black/25 border-line-soft text-ink-mute",
            )}
          >
            {volume != null ? volume.toLocaleString() : "Set"}
            <ChevronDown className="w-4 h-4 text-cyan shrink-0" strokeWidth={2.2} />
          </button>
          {volumeOpen && (
            <ReadingWheelSheet
              key="volume"
              field={VOLUME_WHEEL}
              value={volume ?? undefined}
              onDone={(v) => setVolume(v)}
              onClear={() => setVolume(null)}
              onClose={() => setVolumeOpen(false)}
              clearLabel="Clear"
              presets={VOLUME_PRESETS}
            />
          )}
        </section>
        <section className="rounded-xl border border-line-soft bg-bg-elev px-3.5 py-3">
          <div className="text-[10px] uppercase tracking-wide text-ink-mute">Chlorination</div>
          <div
            role="radiogroup"
            aria-label="Chlorination type"
            className="mt-2 flex p-1 gap-1 rounded-full bg-black/25"
          >
            {SANITISER_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={sanitiser === o.value}
                onClick={() => setSanitiser(o.value as Sanitiser)}
                className={cn(
                  "flex-1 h-9 rounded-full text-base font-medium transition-colors duration-150",
                  sanitiser === o.value ? "bg-cyan/15 text-ink" : "text-ink-dim",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </section>
      </div>

      {customer && savedConfig && configEditing && (
        /* Editing a saved config: Cancel reverts and collapses, Save persists */
        <section className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setVolume(savedConfig.volumeGallons)
              setSanitiser(savedConfig.sanitiser)
              setConfigEditing(false)
            }}
            disabled={savePending}
            className="h-9 px-4 rounded-full text-sm border border-line-soft text-ink-dim active:scale-[0.97] transition-transform"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={saveConfig}
            disabled={savePending || !configDirty || volume == null}
            className={cn(
              "h-9 px-4 rounded-full text-sm font-medium border border-cyan/40 text-cyan",
              "active:scale-[0.97] transition-transform",
              (savePending || !configDirty || volume == null) && "opacity-50",
            )}
          >
            {savePending ? "Saving…" : "Save"}
          </button>
        </section>
      )}
      {customer && !savedConfig && volume != null && (
        /* First save: persist volume+chlorination to the customer */
        <section className="flex justify-end">
          <button
            type="button"
            onClick={saveConfig}
            disabled={savePending}
            className={cn(
              "h-9 px-4 rounded-full text-sm font-medium border border-cyan/40 text-cyan",
              "active:scale-[0.97] transition-transform",
              savePending && "opacity-60",
            )}
          >
            {savePending ? "Saving…" : "Save to customer"}
          </button>
        </section>
      )}
        </>
      )}

      {/* Readings */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <label className="text-base font-medium text-ink-dim">Readings</label>
          <span className="text-xs text-ink-mute">* required readings</span>
        </div>
        <div className="divide-y divide-line-soft/50 rounded-xl border border-line-soft bg-bg-elev">
          {visibleFields.map((f) => {
            const v = readings[f.key]
            return (
              <div key={f.key} className="flex items-center justify-between gap-3 pl-4 pr-3 py-2.5">
                <span className="text-base text-ink-dim">
                  {f.label}
                  {f.unit && <span className="text-ink-mute"> ({f.unit})</span>}
                  {"required" in f && f.required && <span className="text-cyan"> *</span>}
                </span>
                <button
                  type="button"
                  onClick={() => setWheelFor(f.key)}
                  aria-haspopup="dialog"
                  className={cn(
                    "flex items-center gap-1.5 h-11 px-5 rounded-full text-lg tabular-nums",
                    "border transition-colors duration-150 active:scale-[0.98]",
                    v != null
                      ? "bg-cyan/10 border-cyan/40 text-ink"
                      : "bg-black/25 border-line-soft text-ink-mute",
                  )}
                >
                  {v != null ? (f.step < 1 ? v.toFixed(1) : v) : "Set"}
                  <ChevronDown className="w-3.5 h-3.5 text-cyan shrink-0" strokeWidth={2.2} />
                </button>
              </div>
            )
          })}
        </div>
        {wheelFor && (
          <ReadingWheelSheet
            // key forces a fresh mount per field — the sheet's closing/scroll
            // state must never carry across wheelFor changes.
            key={wheelFor}
            field={READING_FIELDS.find((f) => f.key === wheelFor)!}
            value={readings[wheelFor]}
            onDone={(v) => setReadings((r) => ({ ...r, [wheelFor]: v }))}
            onClear={() =>
              setReadings((r) => {
                const { [wheelFor]: _, ...rest } = r
                return rest
              })
            }
            onClose={() => setWheelFor(null)}
            // Once a value is set, the action clears it — say so.
            clearLabel={readings[wheelFor] != null ? "Clear" : "Not measured"}
          />
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3.5 py-2.5">
          {error}
        </p>
      )}
    </div>
  )
}
