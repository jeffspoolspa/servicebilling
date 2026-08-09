import { serve } from "inngest/next"
import { inngest } from "@/lib/jobs/inngest"
import { functions } from "@/lib/jobs/functions"

export const { GET, POST, PUT } = serve({ client: inngest, functions })
export const maxDuration = 300
