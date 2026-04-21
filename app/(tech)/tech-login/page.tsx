"use client"

import { useActionState } from "react"
import { Card, CardBody } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { techLoginAction, type LoginState } from "./actions"

const initial: LoginState = {}

export default function TechLoginPage() {
  const [state, formAction, pending] = useActionState(techLoginAction, initial)

  return (
    <div className="grid place-items-center min-h-[60vh]">
      <Card className="w-full">
        <CardBody className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-2xl">Sign in</h1>
            <p className="text-ink-dim text-sm">Enter the username and password you were given.</p>
          </div>

          <form action={formAction} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-ink-dim text-xs uppercase tracking-[0.14em]">Username</span>
              <input
                name="username"
                required
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                className="bg-[#0E1C2A] border border-line rounded-lg px-3.5 py-3 text-base text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-ink-dim text-xs uppercase tracking-[0.14em]">Password</span>
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="bg-[#0E1C2A] border border-line rounded-lg px-3.5 py-3 text-base text-ink placeholder:text-ink-mute focus:border-cyan focus:outline-none transition-colors"
              />
            </label>

            {state.error && <p className="text-coral text-sm">{state.error}</p>}

            <Button type="submit" variant="primary" disabled={pending} className="h-11 text-base">
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  )
}
