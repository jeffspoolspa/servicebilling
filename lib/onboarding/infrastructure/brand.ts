import "server-only"

/**
 * Candidate-facing brand per office. Richmond Hill operates as Perfect Pools
 * (same as lib/comms/office-config EMAIL_OFFICE_BRANDING); the rest are
 * Jeff's Pool & Spa. Stored in settings.office_brands.
 *
 * Templates are written with "Jeff's Pool & Spa"; withBrand() swaps in the
 * office brand at send time, so editing a template never has to know which
 * office it's for. Staff-facing email always stays Jeff's Pool & Spa.
 */
export interface Brand {
  name: string
  reply_to?: string
}

export const DEFAULT_BRAND: Brand = { name: "Jeff's Pool & Spa" }

export function brandFor(brands: Record<string, Brand> | undefined, office: string | null | undefined): Brand {
  return (office && brands?.[office]) || DEFAULT_BRAND
}

export function withBrand(text: string, brand: Brand): string {
  if (brand.name === DEFAULT_BRAND.name) return text
  const html = brand.name.replace(/&/g, "&amp;")
  return text
    .replace(/Jeff(?:'|&#39;|’)s Pool &amp; Spa(?: Service)?/g, html)
    .replace(/Jeff(?:'|’)s Pool & Spa(?: Service)?/g, brand.name)
}
