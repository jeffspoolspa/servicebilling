import { redirect } from "next/navigation"
import { Paperclip } from "lucide-react"
import { getCurrentEmployee } from "@/lib/auth/require-role"
import { listMyFollowUps } from "@/lib/entities/follow-up"
import { MAINTENANCE_DEPARTMENT_ID } from "@/lib/auth/tech"
import { cn } from "@/lib/utils/cn"

export default async function FollowUpHistoryPage() {
  const employee = await getCurrentEmployee()
  if (!employee) redirect("/tech-login")
  if (employee.department_id !== MAINTENANCE_DEPARTMENT_ID) redirect("/unauthorized")

  const rows = await listMyFollowUps()

  if (rows.length === 0) {
    return (
      <p className="text-ink-mute text-sm py-8 text-center">
        You haven&apos;t submitted any follow-ups yet.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div
          key={r.id}
          className="rounded-xl p-3 bg-bg-elev/60 border border-line-soft flex flex-col gap-1"
        >
          <div className="flex items-center gap-2">
            <span className="text-base text-ink font-medium flex-1 truncate">
              {r.customer_name}
            </span>
            <span
              className={cn(
                "text-[10px] uppercase tracking-wide rounded-full px-2 py-0.5 border shrink-0",
                r.status === "open"
                  ? "text-amber-300 border-amber-300/30 bg-amber-300/5"
                  : "text-grass border-grass/30 bg-grass/5",
              )}
            >
              {r.status}
            </span>
          </div>
          <div className="text-sm text-cyan">{r.issue}</div>
          <p className="text-sm text-ink-dim whitespace-pre-wrap line-clamp-2">
            {r.description}
          </p>
          <div className="flex items-center gap-3 text-xs text-ink-mute">
            <span>
              {new Date(r.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            {r.media_count > 0 && (
              <span className="inline-flex items-center gap-1">
                <Paperclip className="w-3 h-3" strokeWidth={2} />
                {r.media_count}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
