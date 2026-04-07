"use client"

import { useState } from "react"
import { Card, CardBody } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { createSupabaseBrowser } from "@/lib/supabase/client"

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const supabase = createSupabaseBrowser()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    setLoading(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <Card className="w-[420px]">
      <CardBody className="flex flex-col gap-5 p-7">
        <div className="flex flex-col gap-1">
          <div className="w-9 h-9 rounded-[9px] grid place-items-center bg-gradient-to-b from-cyan to-cyan-deep text-[#061018] font-display font-bold text-lg mb-3">
            J
          </div>
          <h1 className="font-display text-2xl">Jeff&apos;s Internal</h1>
          <p className="text-ink-dim text-sm">Sign in with your work email.</p>
        </div>

        {sent ? (
          <div className="text-sm text-grass border border-grass/20 bg-grass/5 rounded-lg p-3.5">
            Check your inbox at <b>{email}</b> for a magic link.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              type="email"
              required
              autoFocus
              placeholder="you@jeffspoolspa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-[#0E1C2A] border border-line rounded-lg px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
            />
            {error && <p className="text-coral text-xs">{error}</p>}
            <Button type="submit" variant="primary" disabled={loading || !email}>
              {loading ? "Sending…" : "Send magic link"}
            </Button>
          </form>
        )}
      </CardBody>
    </Card>
  )
}
