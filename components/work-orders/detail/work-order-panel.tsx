import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { ExpandableText } from "@/components/ui/expandable-text"
import { BillableOverrideToggle } from "@/components/work-orders/billable-override-toggle"
import { Tag, User, Calendar, Building2, DollarSign } from "lucide-react"
import type { WorkOrderDetail } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

/**
 * Work Order tab — everything about the work itself.
 *
 *   ┌─ Work ─────────────────────────────────────────────┐
 *   │ type · tech · office · completed                    │
 *   │ ─ subtotal · tax · total ─                          │
 *   │ [Billable override toggle]                          │
 *   │                                                     │
 *   │ Description                                         │
 *   │ Corrective action                                   │
 *   │ Tech instructions                                   │
 *   └─────────────────────────────────────────────────────┘
 *
 * Money values here are WO-side (ION source). Invoice-side totals (which
 * can differ due to tax or QBO adjustments) live on the Invoice tab +
 * sidebar summary.
 */
export function WorkOrderPanel({ wo }: { wo: WorkOrderDetail }) {
  const techDisplay =
    wo.assigned_to?.split(",")[1]?.trim() ?? wo.assigned_to ?? "—"
  const hasWorkText = Boolean(
    wo.work_description || wo.corrective_action || wo.technician_instructions,
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work</CardTitle>
      </CardHeader>

      {/* Meta strip — type · tech · office · completed. Horizontal row, whitespace-nowrap
          with overflow-x-auto as escape hatch for narrow viewports. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 border-b border-line-soft text-[12px]">
        <MetaItem icon={Tag} label={wo.type ?? "—"} />
        <MetaItem icon={User} label={techDisplay} />
        <MetaItem icon={Building2} label={wo.office_name ?? "—"} />
        <MetaItem
          icon={Calendar}
          label={wo.completed ? formatDate(wo.completed) : "—"}
        />
      </div>

      {/* Money strip — WO subtotal / tax / total */}
      <div className="grid grid-cols-3 gap-4 px-5 py-3 border-b border-line-soft">
        <MoneyItem label="Subtotal" value={formatCurrency(Number(wo.sub_total ?? 0))} />
        <MoneyItem label="Tax" value={formatCurrency(Number(wo.tax_total ?? 0))} />
        <MoneyItem
          label="Total"
          value={formatCurrency(Number(wo.total_due ?? 0))}
          emphasize
        />
      </div>

      {/* Billable override toggle — updates persistence layer so sidebar summary
          reflects the new status on refresh */}
      <div className="px-5 py-3 border-b border-line-soft">
        <BillableOverrideToggle
          woNumber={wo.wo_number}
          override={wo.billable_override}
          effective={wo.billable}
        />
      </div>

      {/* Work description blocks */}
      <CardBody className="text-sm space-y-4 text-ink-dim">
        {hasWorkText ? (
          <>
            {wo.work_description && (
              <Block label="Description">
                <ExpandableText lines={6}>{wo.work_description}</ExpandableText>
              </Block>
            )}
            {wo.corrective_action && (
              <Block label="Corrective action">
                <ExpandableText lines={6}>{wo.corrective_action}</ExpandableText>
              </Block>
            )}
            {wo.technician_instructions && (
              <Block label="Tech instructions">
                <ExpandableText lines={6}>{wo.technician_instructions}</ExpandableText>
              </Block>
            )}
          </>
        ) : (
          <div className="text-ink-mute italic">
            No description, corrective action, or tech instructions on this WO.
          </div>
        )}

        {/* Secondary metadata — less important, parked at bottom */}
        <div className="pt-4 border-t border-line-soft grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
          <Row label="Schedule status">
            <span className="text-ink-dim">{wo.schedule_status ?? "—"}</span>
          </Row>
          <Row label="Assigned to">
            <span className="font-mono text-ink-dim text-[11px]">
              {wo.assigned_to ?? "—"}
            </span>
          </Row>
          <Row label="Started">
            <span className="text-ink-dim">
              {wo.started ? new Date(wo.started).toLocaleString() : "—"}
            </span>
          </Row>
          <Row label="Customer">
            <span className="text-ink-dim">{wo.customer ?? "—"}</span>
          </Row>
        </div>
      </CardBody>
    </Card>
  )
}

function MetaItem({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink-dim">
      <Icon className="w-3 h-3 text-ink-mute" strokeWidth={1.8} />
      {label}
    </span>
  )
}

function MoneyItem({
  label,
  value,
  emphasize,
}: {
  label: string
  value: string
  emphasize?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute flex items-center gap-1">
        <DollarSign className="w-3 h-3" strokeWidth={1.8} />
        {label}
      </div>
      <div
        className={`num mt-0.5 ${emphasize ? "text-ink font-medium text-[15px]" : "text-ink-dim"}`}
      >
        {value}
      </div>
    </div>
  )
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute mb-1">
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-3">
      <span className="text-ink-mute text-[11px] uppercase tracking-wide">{label}</span>
      {children}
    </div>
  )
}
