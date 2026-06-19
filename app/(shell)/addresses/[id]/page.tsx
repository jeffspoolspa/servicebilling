import { ObjectHeader } from "@/components/shell/object-header"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { MapPin } from "lucide-react"
import { notFound } from "next/navigation"
import { getAddressWithCustomers } from "@/lib/queries/dashboard"
import { AddressCustomersManager } from "@/components/customers/address-customers-manager"
import { AddressMap } from "@/components/customers/address-map"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ id: string }>
}

/**
 * Service-address entity page (ADR 005): the canonical address + its place_id/coordinate,
 * and every customer linked to it (manage active owner / unlink).
 */
export default async function AddressDetailPage({ params }: PageProps) {
  const { id } = await params
  const addr = await getAddressWithCustomers(id)
  if (!addr) notFound()

  return (
    <>
      <ObjectHeader back
        eyebrow="Service Address"
        title={addr.street ?? "Address"}
        sub={[addr.city, addr.state, addr.zip].filter(Boolean).join(", ")}
        icon={<MapPin className="w-6 h-6" strokeWidth={1.8} />}
      />
      <div className="px-7 py-6 grid grid-cols-2 gap-5">
        <Card>
          <CardHeader>
            <CardTitle>Address</CardTitle>
          </CardHeader>
          <CardBody className="text-sm space-y-2">
            <Row label="Street" value={addr.street} />
            <Row label="City" value={addr.city} />
            <Row label="State / ZIP" value={[addr.state, addr.zip].filter(Boolean).join(" ") || null} />
            <Row label="place_id" value={addr.place_id} mono />
            <Row
              label="Coordinate"
              value={addr.latitude != null ? `${addr.latitude}, ${addr.longitude}` : null}
              mono
            />
            <Row label="Source" value={addr.geocode_source} />
            {addr.latitude != null && addr.longitude != null && (
              <div className="mt-1">
                <AddressMap
                  token={process.env.MAPBOX_TOKEN ?? null}
                  lat={addr.latitude}
                  lng={addr.longitude}
                  height={220}
                />
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Linked customers ({addr.customer_count})</CardTitle>
          </CardHeader>
          <CardBody>
            <AddressCustomersManager locationId={addr.location_id} customers={addr.customers} />
          </CardBody>
        </Card>
      </div>
    </>
  )
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-mute">{label}</span>
      <span className={`text-right text-ink-dim ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</span>
    </div>
  )
}
