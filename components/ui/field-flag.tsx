/**
 * FieldFlag — the inline "this field is the problem" indicator. A small dot
 * next to the field it describes, with a tooltip explaining the failed check
 * and its consequence. One shared shape so every indicator reads the same:
 * derived-check fails -> dot appears on the field -> hover says why.
 */
export function FieldFlag({
  show,
  title,
  tone = "coral",
}: {
  show: boolean
  title: string
  tone?: "coral" | "sun"
}) {
  if (!show) return null
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
        tone === "coral" ? "bg-coral" : "bg-sun"
      }`}
      title={title}
    />
  )
}
