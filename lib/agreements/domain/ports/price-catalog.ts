/** ION's service-type catalog price — the fallback half of the one-answer
 *  price rule (itemcost ?? catalog). */
export interface PriceCatalog {
  priceCents(serviceTypeId: string): Promise<number | null>
}
