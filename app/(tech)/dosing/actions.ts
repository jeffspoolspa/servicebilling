"use server"

import { z } from "zod"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { canUseTechApp } from "@/lib/auth/tech-app"
import { createSupabaseServer } from "@/lib/supabase/server"
import type { DosingResponse, PoolConfig } from "./shared"

// Accept the env URL with or without a scheme ("host.app" or "https://host.app").
const rawBase = process.env.DOTNET_API_URL ?? "jpsinternal-production.up.railway.app"
const API_BASE = rawBase.startsWith("http") ? rawBase : `https://${rawBase}`

// Rebuild the payload from a parsed schema so only known fields — never
// arbitrary client JSON — travel with the bearer secret. Absent reading =
// not measured; the schema drops empty values before they reach the wire.
const schema = z.object({
  customerId: z.string().min(1).optional(),
  pool: z.object({
    volumeGallons: z.number().min(1500, "Volume must be at least 1,500 gal (pools only)."),
    sanitiser: z.enum(["tab", "liquid", "salt"]),
  }),
  // FC, pH, CYA and Alk are required by the API contract; the rest optional.
  readings: z.object({
    freeChlorine: z.number({ required_error: "Free Chlorine is required." }).nonnegative(),
    ph: z.number({ required_error: "pH is required." }),
    totalAlkalinity: z.number({ required_error: "Alkalinity is required." }).nonnegative(),
    cyanuricAcid: z.number({ required_error: "Cyanuric Acid is required." }).nonnegative(),
    totalChlorine: z.number().nonnegative().optional(),
    calciumHardness: z.number().nonnegative().optional(),
    salt: z.number().nonnegative().optional(),
    waterTempF: z.number().optional(),
  }),
  algaeOrCloudy: z.boolean().optional(),
})

export type DosingState =
  | { ok: true; data: DosingResponse }
  | { ok: false; error: string }

export async function getRecommendation(input: unknown): Promise<DosingState> {
  const employee = await getCurrentEmployee()
  if (!employee || !(await canUseTechApp(employee))) {
    return { ok: false, error: "Not signed in to the field app." }
  }

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid sample." }
  }

  const secret = process.env.DOTNET_API_SECRET
  if (!secret) return { ok: false, error: "Dosing API is not configured (DOTNET_API_SECRET)." }

  const requestedBy =
    [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
    (employee.employee_code as string | null) ||
    "tech"

  let res: Response
  try {
    res = await fetch(`${API_BASE}/maintenance/dosing/recommendations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...parsed.data, requestedBy }),
      cache: "no-store",
    })
  } catch {
    return { ok: false, error: "Could not reach the dosing service. Check signal and retry." }
  }

  if (!res.ok) {
    // 400s carry the domain's own reading-guard text (WaterRuleException) —
    // show it verbatim; anything else gets a generic message.
    let message = `Dosing service error (${res.status}).`
    try {
      const body = await res.json()
      const detail =
        typeof body === "string"
          ? body
          : (body?.detail ?? body?.title ?? body?.error ?? body?.message)
      if (res.status === 400 && typeof detail === "string" && detail) message = detail
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    return { ok: false, error: message }
  }

  try {
    return { ok: true, data: (await res.json()) as DosingResponse }
  } catch {
    return { ok: false, error: "Unexpected response from the dosing service." }
  }
}

/** Saved per-customer dosing defaults — maintenance.pool_configs, one row
 * per customer. Missing row is a normal answer, not an error. */
export async function getPoolConfig(customerId: string): Promise<PoolConfig | null> {
  const employee = await getCurrentEmployee()
  if (!employee || !(await canUseTechApp(employee))) return null
  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .schema("maintenance")
    .from("pool_configs")
    .select("volume_gallons, sanitiser")
    .eq("customer_id", customerId)
    .maybeSingle()
  if (!data) return null
  return { volumeGallons: data.volume_gallons, sanitiser: data.sanitiser }
}

const poolConfigSchema = z.object({
  customerId: z.string().min(1),
  volumeGallons: z.number().int().min(1500),
  sanitiser: z.enum(["tab", "liquid", "salt"]),
})

export async function savePoolConfig(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const employee = await getCurrentEmployee()
  if (!employee || !(await canUseTechApp(employee))) {
    return { ok: false, error: "Not signed in to the field app." }
  }
  const parsed = poolConfigSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid pool configuration." }
  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .schema("maintenance")
    .from("pool_configs")
    .upsert(
      {
        customer_id: Number(parsed.data.customerId),
        volume_gallons: parsed.data.volumeGallons,
        sanitiser: parsed.data.sanitiser,
        last_set_by: employee.id,
      },
      { onConflict: "customer_id" },
    )
  if (error) return { ok: false, error: "Could not save — check signal and retry." }
  return { ok: true }
}
