"use client"

import { useActionState } from "react"
import { Card, CardBody } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { officeLoginAction, type LoginState } from "./actions"

const initial: LoginState = {}

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(officeLoginAction, initial)

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

        <form action={formAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-ink-dim text-xs uppercase tracking-[0.14em]">
              Email
            </span>
            <input
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="username"
              spellCheck={false}
              placeholder="you@jeffspoolspa.com"
              className="bg-[#0E1C2A] border border-line rounded-lg px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-ink-dim text-xs uppercase tracking-[0.14em]">
              Password
            </span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="bg-[#0E1C2A] border border-line rounded-lg px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
            />
          </label>

          {state.error && <p className="text-coral text-xs">{state.error}</p>}

          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}
