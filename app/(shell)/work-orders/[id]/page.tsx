import { Topbar } from "@/components/shell/topbar"
import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Pill } from "@/components/ui/pill"
import { ClipboardList, MapPin, User, Wrench } from "lucide-react"
import { notFound } from "next/navigation"
import Link from "next/link"
import { getWorkOrderDetail, type LineItem } from "@/lib/queries/dashboard"
import { formatCurrency, formatDate } from "@/lib/utils/format"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

const STATUS_TONES: Record<string, "cyan" | "teal" | "sun" | "coral" | "grass" | "neutral"> = {
  not_billable: "neutral",
  needs_classification: "cyan",
  ready_to_process: "cyan",
  processing: "indigo" as never,
  processed: "grass",
  needs_review: "sun",
  skipped: "neutral",
  on_hold: "sun",
}

export default async function WorkOrderDetailPage({ params }: PageProps) {
  const { id } = await params
  const data = await getWorkOrderDetail(id)
  if (!data) notFound()

  const { wo, invoice } = data
  const tone = STATUS_TONES[wo.billing_status] ?? "neutral"
  const techDisplay = wo.assigned_to?.split(",")[1]?.trim() ?? wo.assigned_to ?? "—"

  return (
    <>
      <Topbar
        crumbs={[
          { label: "Work Orders", href: "/work-orders" },
          { label: wo.wo_number },
        ]}
      />

      <ObjectHeader
        eyebrow={`${wo.type} · ${wo.office_name ?? "—"}`}
        title={`WO ${wo.wo_number}`}
        sub={`${wo.customer ?? "—"} · ${techDisplay} · completed ${formatDate(wo.completed)}`}
        icon={<ClipboardList className="w-6 h-6" strokeWidth={1.8} />}
        actions={
          <div className="flex items-center gap-2">
            <Pill tone={tone} dot>
              {wo.billing_status.replace(/_/g, " ")}
            </Pill>
          </div>
        }
      />

      <div className="px-7 py-6 grid grid-cols-3 gap-5">
        {/* Left column: WO details + customer + work description */}
        <div className="col-span-2 flex flex-col gap-5">
          {/* Invoice + line items panel */}
          <Card>
            <CardHeader>
              <CardTitle>
                {invoice ? `Invoice ${invoice.doc_number}` : "Invoice (not yet cached)"}
              </CardTitle>
              {invoice && (
                <div className="ml-auto flex items-center gap-2">
                  {invoice.email_status === "EmailSent" && (
                    <Pill tone="teal" dot>
                      sent
                    </Pill>
                  )}
                  {Number(invoice.balance) === 0 && (
                    <Pill tone="grass" dot>
                      paid
                    </Pill>
                  )}
                  {Number(invoice.balance) > 0 && (
                    <Pill tone="sun" dot>
                      open {formatCurrency(Number(invoice.balance))}
                    </Pill>
                  )}
                </div>
              )}
            </CardHeader>

            {invoice ? (
              <>
                <div className="px-5 py-3 grid grid-cols-4 gap-4 text-[12px] border-b border-line-soft">
                  <Field label="Customer" value={invoice.customer_name ?? "—"} />
                  <Field label="Txn Date" value={formatDate(invoice.txn_date)} />
                  <Field label="Total" value={formatCurrency(Number(invoice.total_amt ?? 0))} mono />
                  <Field label="Balance" value={formatCurrency(Number(invoice.balance ?? 0))} mono />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute border-b border-line-soft bg-[#0c1926]">
                        <th className="px-5 py-2 font-medium">Item</th>
                        <th className="font-medium">Description</th>
                        <th className="font-medium num text-right">Qty</th>
                        <th className="font-medium num text-right">Unit</th>
                        <th className="font-medium num text-right pr-5">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(invoice.line_items ?? []).map((li: LineItem, idx: number) => {
                        const isSubtotal = li.line_type === "subtotal"
                        const isDiscount = li.line_type === "discount"
                        return (
                          <tr
                            key={idx}
                            className={
                              "border-b border-line-soft " +
                              (isSubtotal ? "bg-white/[0.02] font-medium" : "")
                            }
                          >
                            <td className="px-5 py-2">
                              {isSubtotal ? (
                                <span className="text-ink-dim text-[11px] uppercase tracking-wider">
                                  Subtotal
                                </span>
                              ) : isDiscount ? (
                                <span className="text-coral text-xs">Discount</span>
                              ) : (
                                <span className="text-ink text-xs">{li.item_name ?? "—"}</span>
                              )}
                            </td>
                            <td className="text-ink-dim text-xs">
                              {li.description || "—"}
                            </td>
                            <td className="num text-right text-ink-mute text-xs">
                              {li.qty != null ? li.qty : ""}
                            </td>
                            <td className="num text-right text-ink-mute text-xs">
                              {li.unit_price != null ? formatCurrency(li.unit_price) : ""}
                            </td>
                            <td
                              className={
                                "num text-right pr-5 " +
                                (isSubtotal ? "text-ink" : "text-ink-dim") +
                                (isDiscount ? " text-coral" : "")
                              }
                            >
                              {formatCurrency(Number(li.amount ?? 0))}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {(invoice.line_items?.length ?? 0) === 0 && (
                    <div className="px-5 py-6 text-center text-ink-mute text-sm">
                      No line items returned from QBO.
                    </div>
                  )}
                </div>
              </>
            ) : (
              <CardBody className="text-ink-mute text-sm">
                {wo.invoice_number
                  ? `Invoice ${wo.invoice_number} hasn't been pulled from QBO yet. Run pull_qbo_invoices.`
                  : "This WO doesn't have an invoice number yet — office hasn't entered it in ION."}
              </CardBody>
            )}
          </Card>

          {/* Work description */}
          {(wo.work_description || wo.technician_instructions || wo.corrective_action) && (
            <Card>
              <CardHeader>
                <CardTitle>Work</CardTitle>
              </CardHeader>
              <CardBody className="text-sm space-y-3 text-ink-dim">
                {wo.work_description && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute mb-1">
                      Description
                    </div>
                    <div className="whitespace-pre-wrap">{wo.work_description}</div>
                  </div>
                )}
                {wo.corrective_action && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute mb-1">
                      Corrective action
                    </div>
                    <div className="whitespace-pre-wrap">{wo.corrective_action}</div>
                  </div>
                )}
                {wo.technician_instructions && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute mb-1">
                      Tech instructions
                    </div>
                    <div className="whitespace-pre-wrap">{wo.technician_instructions}</div>
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>

        {/* Right column: classification + customer/tech */}
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Classification</CardTitle>
            </CardHeader>
            <CardBody className="text-sm space-y-2">
              <Row label="Status">
                <Pill tone={tone} dot>
                  {wo.billing_status.replace(/_/g, " ")}
                </Pill>
              </Row>
              <Row label="Payment method">
                {wo.payment_method ? (
                  <span
                    className={
                      wo.payment_method === "on_file" ? "text-cyan" : "text-ink-dim"
                    }
                  >
                    {wo.payment_method === "on_file" ? "On file" : "Invoice"}
                  </span>
                ) : (
                  <span className="text-ink-mute">—</span>
                )}
              </Row>
              <Row label="Service category">
                <span className="text-ink-dim">{wo.service_category ?? "—"}</span>
              </Row>
              <Row label="QBO class">
                <span className="text-ink-dim">{wo.qbo_class ?? "—"}</span>
              </Row>
              <Row label="Office">
                <span className="text-ink-dim">{wo.office_name ?? "—"}</span>
              </Row>
              {wo.needs_review_reason && (
                <Row label="Review reason">
                  <span className="text-sun text-xs">{wo.needs_review_reason}</span>
                </Row>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Money</CardTitle>
            </CardHeader>
            <CardBody className="text-sm space-y-2">
              <Row label="Subtotal">
                <span className="num text-ink-dim">
                  {formatCurrency(Number(wo.sub_total ?? 0))}
                </span>
              </Row>
              <Row label="Tax">
                <span className="num text-ink-dim">
                  {formatCurrency(Number(wo.tax_total ?? 0))}
                </span>
              </Row>
              <Row label="Total due">
                <span className="num text-ink font-medium">
                  {formatCurrency(Number(wo.total_due ?? 0))}
                </span>
              </Row>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tech</CardTitle>
            </CardHeader>
            <CardBody className="text-sm space-y-2">
              <Row label="Assigned to">
                <span className="font-mono text-ink text-xs">
                  {wo.assigned_to ?? "—"}
                </span>
              </Row>
              <Row label="Started">
                <span className="text-ink-dim text-xs">
                  {wo.started ? new Date(wo.started).toLocaleString() : "—"}
                </span>
              </Row>
              <Row label="Completed">
                <span className="text-ink-dim text-xs">
                  {wo.completed ? formatDate(wo.completed) : "—"}
                </span>
              </Row>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-mute">{label}</div>
      <div className={mono ? "num text-ink mt-0.5" : "text-ink mt-0.5"}>{value}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-ink-mute">{label}</span>
      {children}
    </div>
  )
}
