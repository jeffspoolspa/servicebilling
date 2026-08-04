"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { mintCardCaptureSession, refreshWalletAfterCapture } from "./actions"

interface Props {
  customerId: string
  /** Origin of the card-vault SPA — also the only postMessage origin we trust. */
  vaultUrl: string
}

type Saved = { method_type?: string; brand?: string; last4?: string }

export function AddCardPanel({ customerId, vaultUrl }: Props) {
  const router = useRouter()
  const [session, setSession] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)
  const [minting, startMint] = useTransition()
  const [, startRefresh] = useTransition()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== vaultUrl) return
      const data = e.data as { type?: string; height?: number; code?: string; message?: string } & Saved
      if (data?.type === "resize" && data.height && iframeRef.current) {
        iframeRef.current.style.height = `${data.height}px`
      }
      if (data?.type === "card_saved") {
        setSaved({ method_type: data.method_type, brand: data.brand, last4: data.last4 })
        setSession(null)
        startRefresh(async () => {
          const r = await refreshWalletAfterCapture(customerId)
          if (r.error) setRefreshNote(r.error)
          router.refresh()
        })
      }
      if (data?.type === "card_error") {
        setError(data.message ?? data.code ?? "Card could not be saved.")
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [customerId, vaultUrl, router])

  function open() {
    setError(null)
    setSaved(null)
    setRefreshNote(null)
    startMint(async () => {
      const r = await mintCardCaptureSession(customerId)
      if (r.error || !r.session) setError(r.error ?? "Could not start card capture.")
      else setSession(r.session)
    })
  }

  return (
    <div className="mb-4 flex flex-col gap-2">
      {!session && (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="primary" onClick={open} disabled={minting}>
            {minting ? "Starting…" : "Add card or bank account"}
          </Button>
          {saved && (
            <span className="text-grass text-sm">
              {saved.brand ?? (saved.method_type === "ach" ? "Bank account" : "Card")}
              {saved.last4 ? ` ····${saved.last4}` : ""} saved to QBO.
            </span>
          )}
        </div>
      )}
      {error && <p className="text-coral text-sm">{error}</p>}
      {refreshNote && <p className="text-sun text-xs">{refreshNote}</p>}
      {session && (
        <div className="border border-line-soft rounded-lg overflow-hidden bg-white">
          <iframe
            ref={iframeRef}
            title="Card capture"
            // theme=light is REQUIRED, not cosmetic: with no theme the capture
            // page follows prefers-color-scheme, and this app is dark — so it
            // renders its light-on-dark palette onto the white panel below and
            // the whole form becomes invisible white-on-white.
            src={`${vaultUrl}/capture?session=${session}&origin=${encodeURIComponent(window.location.origin)}&theme=light`}
            className="w-full"
            style={{ height: 460 }}
          />
        </div>
      )}
      {session && (
        <button
          type="button"
          onClick={() => setSession(null)}
          className="text-ink-mute text-xs self-start hover:text-ink"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
