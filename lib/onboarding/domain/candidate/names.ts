/**
 * Naming conventions for the JPS Hiring Drive root (binding, from the build
 * plan's "Shared conventions"):
 *
 *   folder: `Last, First`                    (title case, suffixes kept)
 *   file:   `Last, First - <DocType> - YYYY-MM-DD.<ext>`
 */
export const DOC_TYPES = ["MVR", "Drivers License", "Criminal History", "Interview Scorecard", "Application"] as const
export type DocType = (typeof DOC_TYPES)[number] | `Other - ${string}`

/** Title-case a name while keeping roman-numeral suffixes (II, III, IV) and "jr". */
export function titleCaseName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => {
      if (/^(i{1,3}|iv|v)$/i.test(word)) return word.toUpperCase()
      return word
        .split(/([-'])/)
        .map((part) => (part === "-" || part === "'" ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
        .join("")
    })
    .join(" ")
}

export function personFolderName(last: string, first: string, isTest = false): string {
  const base = `${titleCaseName(last)}, ${titleCaseName(first)}`
  return isTest ? `_TEST ${base}` : base
}

export function docFileName(last: string, first: string, docType: DocType, isoDate: string, ext: string): string {
  return `${titleCaseName(last)}, ${titleCaseName(first)} - ${docType} - ${isoDate}.${ext.replace(/^\./, "")}`
}

/** Normalize to 10 US digits, or null. Strips a leading 1. */
export function tenDigitPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = raw.replace(/\D/g, "")
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1)
  return d.length === 10 ? d : null
}

export function formatPhone(raw: string | null | undefined): string {
  const d = tenDigitPhone(raw)
  if (!d) return raw ?? ""
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}
